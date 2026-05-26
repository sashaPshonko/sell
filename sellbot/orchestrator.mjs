import 'dotenv/config';
import { Worker } from 'worker_threads';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { startWsServer, enqueueBotEvent } from './lib/ws-server.mjs';
import { createTelegramBot } from './lib/telegram.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let sendAlert = async (m) => console.log(`🔔 ${m}`);
let isShuttingDown = false;
let workerEntry = null;
let botConfig = null;
let workerReady = false;
let healthCheckPaused = false;
let healthCheckRunning = false;
/** true пока воркер реально на проверке (до health_check ответа) */
let healthInProgress = false;
/** orderId → последний заказ (для nick_update) */
const activeOrders = new Map();

function parseMarkers(envKey, fallback) {
    const raw = process.env[envKey] || fallback;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function forwardToSell(ev) {
    enqueueBotEvent(ev);
}

function isMockDelivery() {
    return process.env.MOCK_DELIVERY === '1';
}

async function mockDeliverOk(order) {
    const orderId = order.orderId;
    const short = orderId?.slice(0, 8) || '?';
    const delayMs = Number(process.env.MOCK_DELIVERY_MS || 300);

    console.log(
        `[sellbot] MOCK delivery_ok ${short}… ${order.nick || '?'} ${order.amount ?? '?'}kk`,
    );
    await sendAlert(
        `🧪 MOCK выдача\n` +
            `Ник: ${order.nick || '?'}\n` +
            `Сумма: ${order.amount ?? '?'}kk\n` +
            `Заказ: ${short}…`,
    );

    if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
    }

    forwardToSell({ type: 'delivery_ok', orderId });
    activeOrders.delete(orderId);
    await sendAlert(`✅ MOCK: заказ ${short}…`);
}

function isValidNick(nick) {
    return typeof nick === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(nick);
}

function healthCheckEnabled() {
    return process.env.HEALTH_CHECK_ENABLED !== '0' && !isMockDelivery();
}

function waitForWorkerReady(timeoutMs = 120_000) {
    if (workerReady) return Promise.resolve(true);
    return new Promise((resolve) => {
        const poll = setInterval(() => {
            if (workerReady) {
                clearInterval(poll);
                clearTimeout(timer);
                resolve(true);
            }
        }, 500);
        const timer = setTimeout(() => {
            clearInterval(poll);
            resolve(false);
        }, timeoutMs);
    });
}

function clearHealthInProgress() {
    healthInProgress = false;
    healthCheckRunning = false;
}

async function runScheduledHealthCheck() {
    if (isShuttingDown || !healthCheckEnabled() || healthCheckPaused || healthCheckRunning) {
        return;
    }
    if (activeOrders.size > 0) {
        console.log('[sellbot] health: пропуск — есть активные заказы');
        return;
    }

    healthCheckRunning = true;
    healthInProgress = true;
    console.log('[sellbot] health: заход на анархию (бан / капча / баланс)…');

    try {
        if (!workerEntry) {
            await startWorker('health_check');
            const ok = await waitForWorkerReady();
            if (!ok) {
                clearHealthInProgress();
                await sendAlert(`⚠️ ${botConfig.username}: проверка — таймаут входа`);
                return;
            }
        }
        if (!safePostToWorker({ type: 'health_check' })) {
            clearHealthInProgress();
            console.warn('[sellbot] health: воркер не принял команду');
        }
    } catch (e) {
        clearHealthInProgress();
        throw e;
    }
}

function startHealthCheckLoop() {
    if (!healthCheckEnabled()) return;

    const intervalMs = Number(process.env.HEALTH_CHECK_MS || 3_600_000);
    const firstMs = Number(process.env.HEALTH_CHECK_FIRST_MS || 120_000);
    console.log(
        `[sellbot] проверка анархии: каждые ${Math.round(intervalMs / 60_000)} мин, если нет заказов`,
    );

    setTimeout(() => void runScheduledHealthCheck(), firstMs);
    setInterval(() => void runScheduledHealthCheck(), intervalMs);
}

function scheduleDeliver(order) {
    const tryDeliver = () => {
        if (safePostToWorker({ type: 'deliver', order })) return;
        setTimeout(tryDeliver, 2000);
    };

    if (workerReady) {
        tryDeliver();
    } else {
        const waitReady = setInterval(() => {
            if (workerReady) {
                clearInterval(waitReady);
                tryDeliver();
            }
        }, 1000);
        setTimeout(() => clearInterval(waitReady), 120000);
    }
}

async function loadBotConfig() {
    const path = process.env.BOT_CONFIG || join(__dirname, 'bot.json');
    if (!existsSync(path)) {
        throw new Error(`нет ${path}`);
    }
    const arr = JSON.parse(await readFile(path, 'utf-8'));
    if (!Array.isArray(arr) || !arr[0]?.username) {
        throw new Error(`${path}: нужен массив с username/password/anarchy`);
    }
    botConfig = arr[0];
    console.log(`[sellbot] бот: ${botConfig.username}, анархия ${botConfig.anarchy}`);
}

function workerDataPayload() {
    return {
        username: botConfig.username,
        password: botConfig.password,
        anarchy: botConfig.anarchy,
        payTemplate: process.env.PAY_TEMPLATE || '/pay {nick} {amount}',
        paySuffix: process.env.PAY_SUFFIX ?? 'kk',
        offlineMarkers: parseMarkers('PAY_OFFLINE_MARKERS', 'не в сети,оффлайн,не онлайн'),
        invalidNickMarkers: parseMarkers('PAY_INVALID_NICK_MARKERS', 'не найден,ник не найден,игрок не найден'),
        failMarkers: parseMarkers('PAY_FAIL_MARKERS', 'недостаточно,ошибка,отказано'),
    };
}

function safePostToWorker(msg) {
    const w = workerEntry?.worker;
    if (!w) return false;
    try {
        w.postMessage(msg);
        return true;
    } catch (e) {
        console.warn('[worker] postMessage:', e.message);
        return false;
    }
}

async function stopWorker() {
    workerReady = false;
    if (!workerEntry) return;
    safePostToWorker({ type: 'stop' });
    const w = workerEntry.worker;
    workerEntry = null;
    return new Promise((resolve) => {
        const t = setTimeout(resolve, 5000);
        w.once('exit', () => {
            clearTimeout(t);
            resolve();
        });
        try {
            w.terminate();
        } catch {
            clearTimeout(t);
            resolve();
        }
    });
}

async function startWorker(reason = 'order') {
    if (workerEntry?.worker || isShuttingDown) return;
    console.log(`[sellbot] запуск воркера (${reason})…`);

    const worker = new Worker(join(__dirname, 'worker.mjs'), {
        workerData: workerDataPayload(),
    });

    workerEntry = { worker };

    worker.on('message', async (message) => {
        try {
            if (typeof message === 'string') {
                await sendAlert(message);
                return;
            }

            if (message?.name === 'ready') {
                workerReady = true;
                console.log('[sellbot] бот на анархии, готов к /pay');
                return;
            }

            if (message?.name === 'shutdown') {
                workerReady = false;
                console.log(`[sellbot] бот офлайн (${message.reason || '?'})`);
                return;
            }

            if (message?.name === 'banned') {
                await sendAlert(`🚫 ${botConfig.username} забанен на сервере`);
                await stopWorker();
                return;
            }

            if (message?.name === 'kicked') {
                await sendAlert(`⛔ ${botConfig.username} kicked: ${message.reason || '?'}`);
                workerReady = false;
                return;
            }

            if (message?.name === 'connect_failed') {
                await sendAlert(`❌ ${botConfig.username}: не подключился — ${message.reason || '?'}`);
                workerReady = false;
                return;
            }

            if (message?.name === 'health_balance') {
                const bal = message.balance;
                const min = Number(process.env.BALANCE_MIN || 1_000_000_000);
                if (bal == null || !Number.isFinite(bal)) {
                    console.warn('[sellbot] health: баланс не получен');
                    await sendAlert(`⚠️ ${botConfig.username}: не удалось прочитать баланс (/balance)`);
                    return;
                }
                console.log(`[sellbot] health: баланс ${bal}`);
                if (bal < min) {
                    await sendAlert(
                        `⚠️ ${botConfig.username}: мало баланса!\n` +
                            `${bal.toLocaleString('ru-RU')} < ${min.toLocaleString('ru-RU')}`,
                    );
                }
                return;
            }

            if (message?.name === 'health_check') {
                clearHealthInProgress();
                const st = message.status || '?';
                const bal = message.balance;
                if (st === 'interrupted') {
                    console.log('[sellbot] health: прервана — выдача заказа');
                    return;
                }
                if (st === 'ok') {
                    const min = Number(process.env.BALANCE_MIN || 1_000_000_000);
                    const balNote =
                        bal != null && Number.isFinite(bal)
                            ? `, баланс ${bal.toLocaleString('ru-RU')}`
                            : '';
                    console.log(`[sellbot] health: ок${balNote}`);
                    if (bal != null && Number.isFinite(bal) && bal < min) {
                        return;
                    }
                    await sendAlert(`✅ ${botConfig.username}: проверка анархии ок${balNote}`);
                } else if (st === 'banned') {
                    healthCheckPaused = true;
                    await sendAlert(`🚫 ${botConfig.username}: бан (проверка)`);
                    await stopWorker();
                } else if (st === 'captcha') {
                    healthCheckPaused = true;
                    await sendAlert(`🔐 ${botConfig.username}: капча (проверка)`);
                    await stopWorker();
                } else {
                    console.warn(`[sellbot] health: ${st}`);
                }
                return;
            }

            if (message?.name === 'health_skipped') {
                clearHealthInProgress();
                console.log(`[sellbot] health: пропуск (${message.reason || 'busy'})`);
                return;
            }

            if (message?.name === 'health_check_failed') {
                clearHealthInProgress();
                await sendAlert(
                    `❌ ${botConfig.username}: проверка — ${message.reason || 'ошибка'}`,
                );
                return;
            }

            const orderId = message.orderId;
            if (!orderId) return;

            const evType = {
                delivery_ok: 'delivery_ok',
                delivery_failed: 'delivery_failed',
                delivery_stalled: 'delivery_stalled',
                invalid_nick: 'invalid_nick',
                player_offline: 'player_offline',
            }[message.name];

            if (evType) {
                const ev = { type: evType, orderId };
                if (message.reason) ev.reason = message.reason;
                if (message.queued != null) ev.queued = message.queued;
                forwardToSell(ev);

                const short = orderId.slice(0, 8);
                const order = activeOrders.get(orderId);

                if (evType === 'delivery_ok') {
                    activeOrders.delete(orderId);
                    await sendAlert(`✅ Выдано: заказ ${short}…`);
                } else if (evType === 'delivery_stalled') {
                    const q = message.queued ?? '?';
                    await sendAlert(
                        `⏱ Заказ ${short}… не выдан за 1 мин (в очереди ещё ${q}).\n` +
                            `Покупатель: ${order?.buyer || '?'}\n` +
                            `Ник: ${order?.nick || '?'}\n` +
                            `Попроси в PlayerOK снова: /nick ник`,
                    );
                } else if (evType === 'player_offline') {
                    await sendAlert(`⚠️ Оффлайн: ${short}… — пусть шлёт /nick на анархии`);
                } else if (evType === 'invalid_nick') {
                    await sendAlert(`⚠️ Неверный ник: ${short}…`);
                } else {
                    await sendAlert(
                        `❌ Выдача ${short}…: ${message.reason || evType}\n` +
                            `Покупатель может снова: /nick ник`,
                    );
                }
            }
        } catch (e) {
            await sendAlert(`❌ worker handler: ${e.message}`);
        }
    });

    worker.on('error', async (err) => {
        await sendAlert(`❌ ${botConfig.username}: ${err.message}`);
        workerReady = false;
    });

    worker.on('exit', (code) => {
        workerReady = false;
        workerEntry = null;
        if (isShuttingDown) return;
        if (code === 0 || code === 2 || code === 3) {
            console.log(`[sellbot] воркер выключен (code ${code}), ждём заказ`);
            return;
        }
        console.warn(`[sellbot] воркер exit ${code} → перезапуск через 15с`);
        setTimeout(() => startWorker('restart'), 15000);
    });
}

async function handleOrder(order) {
    activeOrders.set(order.orderId, order);

    if (healthInProgress) {
        console.log(`[sellbot] заказ ${order.orderId.slice(0, 8)}… — прерываем проверку`);
    }

    if (isMockDelivery()) {
        await mockDeliverOk(order);
        return;
    }

    if (!isValidNick(order.nick)) {
        console.warn(`[sellbot] заказ ${order.orderId}: нет ника — воркер не трогаем`);
        return;
    }

    const short = order.orderId?.slice(0, 8) || '?';
    await sendAlert(
        `💰 Выдача PlayerOK\n` +
            `Покупатель: ${order.buyer || '?'}\n` +
            `Ник: ${order.nick}\n` +
            `Сумма: ${order.amount}kk\n` +
            `Анархия: ${order.anarchy || botConfig.anarchy}\n` +
            `Заказ: ${short}…`,
    );

    if (!workerEntry) {
        await startWorker('payment');
    }

    scheduleDeliver(order);
}

function handleCancelOrder(orderId) {
    activeOrders.delete(orderId);
    safePostToWorker({ type: 'cancel_order', orderId });
    console.log(`[sellbot] отмена заказа ${orderId.slice(0, 8)}…`);
}

function handleNickUpdate(orderId, nick) {
    const prev = activeOrders.get(orderId);
    if (!prev) {
        console.warn(`[sellbot] nick_update без заказа ${orderId}`);
        return;
    }
    if (!isValidNick(nick)) {
        console.warn(`[sellbot] nick_update ${orderId}: невалидный ник`);
        return;
    }

    const order = { ...prev, nick };
    activeOrders.set(orderId, order);

    if (isMockDelivery()) {
        void mockDeliverOk(order);
        return;
    }

    if (!workerEntry) {
        void startWorker('nick_update').then(() => scheduleDeliver(order));
        return;
    }
    scheduleDeliver(order);
}

async function main() {
    await loadBotConfig();

    if (isMockDelivery()) {
        console.log(
            '[sellbot] MOCK_DELIVERY=1 — сразу delivery_ok, mineflayer не запускается',
        );
    }

    const tg = await createTelegramBot({
        onCommand: {
            '/ping': async (_msg, alert) => {
                const st = workerEntry
                    ? workerReady
                        ? '🟢 воркер на анархии'
                        : '🟡 воркер подключается'
                    : '⚪ воркер выключен';
                await alert(`Sellbot ${botConfig.username}\n${st}`);
            },
            '/stop': async (_msg, alert) => {
                await alert('⏹ Остановка воркера');
                await stopWorker();
            },
            '/start': async (_msg, alert) => {
                await alert('▶️ Запуск воркера');
                await startWorker('manual');
            },
            '/health': async (_msg, alert) => {
                await alert('🔍 Запуск проверки анархии…');
                await runScheduledHealthCheck();
            },
        },
    });
    sendAlert = tg.sendAlert;

    startWsServer({
        onOrder: handleOrder,
        onNickUpdate: handleNickUpdate,
        onCancel: handleCancelOrder,
    });

    console.log(
        '[sellbot] жду подключения sell и заказы (логи появятся при order / MOCK delivery_ok)',
    );

    startHealthCheckLoop();

    process.on('SIGINT', async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log('\n[sellbot] выключение…');
        await stopWorker();
        process.exit(0);
    });
}

main().catch(async (e) => {
    console.error(e);
    await sendAlert(`❌ старт: ${e.message}`);
    process.exit(1);
});
