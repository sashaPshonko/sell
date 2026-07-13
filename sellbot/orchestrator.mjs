import { Worker } from 'worker_threads';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { startWsServer, stopWsServer, enqueueBotEvent } from './lib/ws-server.mjs';
import { createTelegramBot } from './lib/telegram.mjs';
import { loadSettings } from './settings.mjs';
import { maskProxyUrl } from './lib/mc-proxy.mjs';
import { audit } from '../lib/audit.mjs';
import { acquirePidLock, releasePidLock } from '../lib/pid-lock.mjs';
import { isIgnorableProtocolNoise } from './lib/protocol-noise.mjs';
import {
    isRetryableDeliveryFailure,
    MAX_DELIVERY_RETRIES,
    DELIVERY_RETRY_DELAY_MS,
} from './lib/delivery-retry.mjs';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_LOCK = join(__dirname, '.orchestrator.pid');

let sendAlert = async (m) => console.log(`🔔 ${m}`);
let isShuttingDown = false;
let workerEntry = null;
let botConfig = null;
/** @type {import('./settings.mjs').DEFAULTS | null} */
let cfg = null;
let workerReady = false;
let healthCheckPaused = false;
let healthCheckRunning = false;
/** true пока воркер реально на проверке (до health_check ответа) */
let healthInProgress = false;
/** @type {import('ws').WebSocketServer | null} */
let wssInstance = null;
/** @type {import('node-telegram-bot-api') | null} */
let telegramBot = null;
/** orderId → последний заказ (для nick_update) */
const activeOrders = new Map();
/** Успешно выданные — не принимать повторно (cancel/retry не блокирует) */
const closedOrderIds = new Set();
/** orderId → число автоповторов выдачи */
const deliveryRetryCounts = new Map();
/** orderId с запланированным повтором (не дублировать после crash) */
const retryScheduled = new Set();
/** @type {Map<string, NodeJS.Timeout>} */
const retryTimers = new Map();
let pendingCrashReschedule = false;

function forwardToSell(ev) {
    void audit('ws_bot_event', ev);
    enqueueBotEvent(ev);
}

function isMockDelivery() {
    return cfg?.mockDelivery === true;
}

async function mockDeliverOk(order) {
    const orderId = order.orderId;
    const short = orderId?.slice(0, 8) || '?';
    const delayMs = cfg?.mockDeliveryMs ?? 300;

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
    closedOrderIds.add(orderId);
    activeOrders.delete(orderId);
    await sendAlert(`✅ MOCK: заказ ${short}…`);
}

function isValidNick(nick) {
    return typeof nick === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(nick);
}

function healthCheckEnabled() {
    return cfg?.healthCheckEnabled !== false && !isMockDelivery();
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
        }
        // Воркер подключается только после health_check — не ждём ready заранее
        await new Promise((r) => setTimeout(r, 300));
        if (!safePostToWorker({ type: 'health_check' })) {
            clearHealthInProgress();
            console.warn('[sellbot] health: воркер не принял команду');
            await sendAlert(`⚠️ ${botConfig.username}: проверка — воркер не отвечает`);
        }
    } catch (e) {
        clearHealthInProgress();
        throw e;
    }
}

function startHealthCheckLoop() {
    if (!healthCheckEnabled()) return;

    const intervalMs = cfg.healthCheckMs;
    const firstMs = cfg.healthCheckFirstMs;
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
    // deliver → ensureBot → ready; ждать ready до deliver нельзя (deadlock)
    tryDeliver();
}

function clearDeliveryRetry(orderId) {
    deliveryRetryCounts.delete(orderId);
    retryScheduled.delete(orderId);
    const t = retryTimers.get(orderId);
    if (t) {
        clearTimeout(t);
        retryTimers.delete(orderId);
    }
}

function scheduleDeliveryRetry(order, reason) {
    const orderId = order.orderId;
    if (!orderId || closedOrderIds.has(orderId)) return;

    const attempt = (deliveryRetryCounts.get(orderId) || 0) + 1;
    if (attempt > MAX_DELIVERY_RETRIES) {
        clearDeliveryRetry(orderId);
        console.warn(
            `[sellbot] автоповтор исчерпан ${orderId.slice(0, 8)}… (${reason})`,
        );
        forwardToSell({ type: 'delivery_failed', orderId, reason: 'max_retries' });
        void sendAlert(
            `❌ Выдача ${orderId.slice(0, 8)}…: повторы исчерпаны\n` +
                `Покупатель может снова: /nick ник`,
        );
        return;
    }

    deliveryRetryCounts.set(orderId, attempt);
    retryScheduled.add(orderId);

    const existing = retryTimers.get(orderId);
    if (existing) clearTimeout(existing);

    const delayMs = DELIVERY_RETRY_DELAY_MS;
    console.log(
        `[sellbot] автоповтор ${orderId.slice(0, 8)}… #${attempt}/${MAX_DELIVERY_RETRIES} ` +
            `через ${Math.round(delayMs / 1000)}с (${reason})`,
    );
    void sendAlert(
        `🔄 Повтор выдачи ${orderId.slice(0, 8)}… (${attempt}/${MAX_DELIVERY_RETRIES})\n` +
            `Причина: ${reason}`,
    );

    const timer = setTimeout(() => {
        retryTimers.delete(orderId);
        if (!activeOrders.has(orderId) || closedOrderIds.has(orderId)) return;
        if (!workerEntry) {
            void startWorker('retry').then(() => scheduleDeliver(order));
        } else {
            scheduleDeliver(order);
        }
    }, delayMs);
    retryTimers.set(orderId, timer);
}

/** Мгновенный exit на kill — sellbot.sh поднимет снова через 5s */
function hardShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[sellbot] ${signal} — завершение`);
    workerReady = false;
    try {
        workerEntry?.worker?.terminate();
    } catch { /* */ }
    workerEntry = null;
    try {
        stopWsServer();
    } catch { /* */ }
    wssInstance = null;
    try {
        telegramBot?.stopPolling();
    } catch { /* */ }
    telegramBot = null;
    try {
        if (
            existsSync(ORCHESTRATOR_LOCK) &&
            readFileSync(ORCHESTRATOR_LOCK, 'utf8') === String(process.pid)
        ) {
            releasePidLock(ORCHESTRATOR_LOCK);
        }
    } catch { /* */ }
    process.exit(0);
}

async function loadBotConfig() {
    const loaded = await loadSettings();
    botConfig = loaded.bot;
    cfg = loaded.settings;
    console.log(`[sellbot] бот: ${botConfig.username}, анархия ${botConfig.anarchy}`);
    if (botConfig.proxy && botConfig.proxy !== 'off') {
        console.log(`[sellbot] mc proxy: ${maskProxyUrl(botConfig.proxy)}`);
    } else {
        console.log('[sellbot] mc proxy: нет (прямое подключение)');
    }
    if (cfg.mockDelivery) {
        console.log('[sellbot] mockDelivery в bot.json — без Minecraft');
    }
}

function workerDataPayload() {
    return {
        username: botConfig.username,
        password: botConfig.password,
        anarchy: botConfig.anarchy,
        proxy: botConfig.proxy,
        deliveryMode: cfg.deliveryMode,
        clanInvestMultiplier: cfg.clanInvestMultiplier,
        clanPhaseTimeoutMs: cfg.clanPhaseTimeoutMs,
        clanWithdrawSoloTimeoutMs: cfg.clanWithdrawSoloTimeoutMs,
        clanLoopWaitMs: cfg.clanLoopWaitMs,
        clanInvestWaitMs: cfg.clanInvestWaitMs,
        clanWithdrawMinRatio: cfg.clanWithdrawMinRatio,
        clanWithdrawGraceMs: cfg.clanWithdrawGraceMs,
        clanWithdrawRemainderMs: cfg.clanWithdrawRemainderMs,
        clanClickDelayMinMs: cfg.clanClickDelayMinMs,
        clanClickDelayMaxMs: cfg.clanClickDelayMaxMs,
        clanMembersMenuSlot: cfg.clanMembersMenuSlot,
        clanKickConfirmSlot: cfg.clanKickConfirmSlot,
        anarchyRejoinWaitMs: cfg.anarchyRejoinWaitMs,
        playerOfflineMarker: cfg.playerOfflineMarker,
        insufficientFundsMarker: cfg.insufficientFundsMarker,
        invalidNickMarkers: cfg.invalidNickMarkers,
        idleQuitMs: cfg.idleQuitMs,
        deliverTimeoutMs: cfg.deliverTimeoutMs,
        balanceWaitMs: cfg.balanceWaitMs,
        balanceCmdWaitMs: cfg.balanceCmdWaitMs,
        clanInfoWaitMs: cfg.clanInfoWaitMs,
        clanInfoCmdWaitMs: cfg.clanInfoCmdWaitMs,
        clanBalanceWaitMs: cfg.clanBalanceWaitMs,
        clanBalanceCmdWaitMs: cfg.clanBalanceCmdWaitMs,
        healthCheckObserveMs: cfg.healthCheckObserveMs,
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
    await loadBotConfig();
    console.log(`[sellbot] запуск воркера (${reason})…`);

    const worker = new Worker(join(__dirname, 'worker.mjs'), {
        workerData: workerDataPayload(),
        stdout: true,
        stderr: true,
    });

    worker.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    worker.stderr?.on('data', (chunk) => process.stderr.write(chunk));

    workerEntry = { worker };

    worker.on('message', async (message) => {
        try {
            if (typeof message === 'string') {
                await sendAlert(message);
                return;
            }

            if (message?.name === 'ready') {
                workerReady = true;
                console.log('[sellbot] бот на анархии, готов к выдаче (клан)');
                if (pendingCrashReschedule) {
                    pendingCrashReschedule = false;
                    for (const order of activeOrders.values()) {
                        if (retryScheduled.has(order.orderId)) continue;
                        scheduleDeliveryRetry(order, 'worker_crash');
                    }
                }
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
                const min = cfg.balanceMin;
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
                    const min = cfg.balanceMin;
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

            if (message?.name === 'delivery_queue') {
                forwardToSell({
                    type: 'delivery_queue',
                    active: message.active ?? null,
                    waiting: message.waiting ?? [],
                });
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
                player_in_other_clan: 'player_in_other_clan',
                invite_declined: 'invite_declined',
                insufficient_funds: 'insufficient_funds',
                clan_invite_sent: 'clan_invite_sent',
                clan_invested: 'clan_invested',
                clan_joined: 'clan_joined',
                clan_withdraw_partial: 'clan_withdraw_partial',
            }[message.name];

            if (evType) {
                if (
                    evType === 'delivery_failed' &&
                    isRetryableDeliveryFailure(message.reason)
                ) {
                    const order = activeOrders.get(orderId);
                    if (order) {
                        scheduleDeliveryRetry(order, message.reason || 'unknown');
                    }
                    return;
                }

                const ev = { type: evType, orderId };
                if (message.reason) ev.reason = message.reason;
                if (message.queued != null) ev.queued = message.queued;
                if (message.playerWithdrawn != null) ev.playerWithdrawn = message.playerWithdrawn;
                if (message.investAmount != null) ev.investAmount = message.investAmount;
                if (message.priorWithdrawn != null) ev.priorWithdrawn = message.priorWithdrawn;
                if (message.fullInvestAmount != null) ev.fullInvestAmount = message.fullInvestAmount;
                if (message.withdrawAmount != null) ev.withdrawAmount = message.withdrawAmount;
                if (message.withdrawn != null) ev.withdrawn = message.withdrawn;
                if (message.full != null) ev.full = message.full;
                if (message.nick) ev.nick = message.nick;
                if (message.amountKk != null) ev.amountKk = message.amountKk;
                forwardToSell(ev);

                const short = orderId.slice(0, 8);
                const order = activeOrders.get(orderId);

                if (evType === 'delivery_ok') {
                    clearDeliveryRetry(orderId);
                    closedOrderIds.add(orderId);
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
                } else if (evType === 'player_in_other_clan') {
                    await sendAlert(
                        `⚠️ ${order?.nick || '?'}: уже в другом клане (заказ ${short}…)\n` +
                            'Пусть выйдет из клана (/clan leave) и снова /nick',
                    );
                } else if (evType === 'invite_declined') {
                    console.log(
                        `[sellbot] invite declined → ${order?.nick || '?'} (${short}…)`,
                    );
                } else if (evType === 'insufficient_funds') {
                    await sendAlert(
                        `💸 ${botConfig.username}: недостаточно денег в казне/балансе (заказ ${short}…)\n` +
                            `Пополни баланс бота — покупателю ник не при чём`,
                    );
                } else if (evType === 'clan_invite_sent') {
                    console.log(`[sellbot] clan invite → ${order?.nick || '?'}`);
                } else if (evType === 'clan_invested') {
                    console.log(`[sellbot] clan invest → ${order?.nick || '?'}`);
                } else if (evType === 'clan_joined') {
                    console.log(`[sellbot] clan joined → ${order?.nick || '?'}`);
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
        if (isIgnorableProtocolNoise(err)) {
            console.warn('[sellbot] protocol noise:', err.message);
            return;
        }
        console.error('[sellbot] worker error:', err);
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
        if (activeOrders.size > 0) {
            pendingCrashReschedule = true;
        }
        console.warn(`[sellbot] воркер exit ${code} → перезапуск через 15с`);
        setTimeout(() => startWorker('restart'), 15_000);
    });
}

async function handleOrder(order) {
    const oid = order.orderId;
    if (closedOrderIds.has(oid)) {
        console.log(`[sellbot] игнор закрытого заказа ${oid.slice(0, 8)}…`);
        return;
    }
    await loadBotConfig();
    activeOrders.set(oid, order);
    console.log(
        `[sellbot] заказ ${order.orderId} | ${order.nick || '?'} | ${order.amount ?? '?'}kk`,
    );
    void audit('sellbot_order', {
        orderId: order.orderId,
        nick: order.nick,
        amountKk: order.amount,
        buyer: order.buyer,
    });

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
    // cancel — снять с воркера; closedOrderIds только после delivery_ok (иначе retry /nick мёртв)
    clearDeliveryRetry(orderId);
    activeOrders.delete(orderId);
    safePostToWorker({ type: 'cancel_order', orderId });
    console.log(`[sellbot] отмена заказа ${orderId.slice(0, 8)}…`);
}

function handleNickUpdate(orderId, nick) {
    if (closedOrderIds.has(orderId)) {
        console.log(`[sellbot] nick_update игнор — заказ ${orderId.slice(0, 8)}… закрыт`);
        return;
    }
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
    acquirePidLock(ORCHESTRATOR_LOCK, 'sellbot', { processPattern: 'orchestrator.mjs' });
    process.on('SIGINT', () => hardShutdown('SIGINT'));
    process.on('SIGTERM', () => hardShutdown('SIGTERM'));
    process.on('SIGHUP', () => hardShutdown('SIGHUP'));

    await loadBotConfig();

    if (isMockDelivery()) {
        console.log(
            '[sellbot] mockDelivery в bot.json — сразу delivery_ok, mineflayer не запускается',
        );
    }

    try {
        wssInstance = await startWsServer(
            {
                onOrder: handleOrder,
                onNickUpdate: handleNickUpdate,
                onCancel: handleCancelOrder,
            },
            cfg.wsPort,
        );
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            process.exit(2);
        }
        throw err;
    }

    const tg = await createTelegramBot({
        telegram: {
            token: cfg.telegramToken,
            chatId: cfg.telegramChatId,
            skip: cfg.telegramSkip,
            proxy: cfg.telegramProxy,
            autoXray: cfg.telegramAutoXray,
            xrayCmd: cfg.telegramXrayCmd,
        },
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
    telegramBot = tg.bot ?? null;

    console.log(
        '[sellbot] жду подключения sell и заказы (логи появятся при order / MOCK delivery_ok)',
    );

    startHealthCheckLoop();
}

main().catch(async (e) => {
    console.error(e);
    if (e?.code !== 'EADDRINUSE') {
        await sendAlert(`❌ старт: ${e.message}`);
    }
    process.exit(e?.code === 'EADDRINUSE' ? 2 : 1);
});
