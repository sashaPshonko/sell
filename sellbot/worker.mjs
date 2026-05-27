import mineflayer from 'mineflayer';
import { parentPort, workerData } from 'worker_threads';
import { antiAfkIfNeeded } from './lib/afk-look.mjs';
import { parseBalanceFromChat } from './lib/balance.mjs';
import { createChatLogger } from './lib/chat-log.mjs';
import { audit } from '../lib/audit.mjs';

/** Успешная выдача /pay на FunTime */
const PAY_SUCCESS_MARKERS = [
    '[✔] Успешно',
    'Успешно!',
    'успешно отправлен',
    'успешно перевед',
    'перевод успешно',
];

const config = {
    username: workerData.username,
    password: workerData.password,
    anarchy: workerData.anarchy,
    payTemplate: workerData.payTemplate || '/pay {nick} {amount}',
    paySuffix: workerData.paySuffix ?? '',
    payAmountMultiplier: workerData.payAmountMultiplier ?? 0,
    offlineMarkers: workerData.offlineMarkers || [],
    invalidNickMarkers: workerData.invalidNickMarkers || [],
    failMarkers: workerData.failMarkers || [],
    idleQuitMs: workerData.idleQuitMs ?? 25_000,
    deliverTimeoutMs: workerData.deliverTimeoutMs ?? 60_000,
    payLoopWaitMs: workerData.payLoopWaitMs ?? 2000,
    balanceWaitMs: workerData.balanceWaitMs ?? 15_000,
    balanceCmdWaitMs: workerData.balanceCmdWaitMs ?? 2000,
    healthCheckObserveMs: workerData.healthCheckObserveMs ?? 8000,
};

const anarchyCmd = `/an${config.anarchy}`;
const AFK_MARKER = 'Данная команда недоступна в режиме AFK';
const CAPTCHA_MARKER = 'BotFilter >> Введите номер с картинки в чат';
const BANNED_MARKER = 'вы забанены';

const LOBBY_IGNORE_MARKERS = [
    '⚡ Наша группа ВК vk.com/funtime',
    '⚡ Наш Телеграм t.me/funtime',
    '⚡ Наш Дискорд dd.FunTime.su',
    '⚡ Наш Сайт FunTime.su',
    '⚡ Наши сообщества и соц. сети /links',
    '⚡ Вы играете на FunTime',
    'Добро пожаловать на FunTime',
];

const botState = { afk: false, balance: null };
const deliverQueue = [];

let bot = null;
let connecting = false;
let ready = false;
let delivering = false;
let currentOrder = null;
let idleQuitTimer = null;
/** Почасовая проверка: бан / капча без заказа */
let healthCheckActive = false;
/** Результат текущей итерации /pay (ставится из чата) */
let payOutcome = null;
let payFailReason = null;

const chatLog = createChatLogger(config.username);
const log = (msg) => chatLog.logInfo(msg);
const logOk = (msg) => chatLog.logOk(msg);

function postEvent(name, extra = {}) {
    parentPort.postMessage({ name, ...extra });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function stripMcFormatting(text) {
    return String(text)
        .replace(/§./g, '')
        .replace(/&[0-9a-fk-or]/gi, '');
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesAny(text, markers) {
    const lower = text.toLowerCase();
    return markers.some((m) => m && lower.includes(String(m).toLowerCase()));
}

function isLobbyNoise(text) {
    return LOBBY_IGNORE_MARKERS.some((m) => text.includes(m));
}

function nickInMessage(text, nick) {
    return new RegExp(`\\b${escapeRegex(nick)}\\b`, 'i').test(text);
}

function formatPayAmount(amountKk) {
    const n = Number(amountKk);
    const mult = Number(config.payAmountMultiplier || 0);
    if (mult > 0) return String(Math.round(n * mult));
    if (config.paySuffix) return `${n}${config.paySuffix}`;
    return String(n);
}

function buildPayCommand(order) {
    const amount = formatPayAmount(order.amount);
    return config.payTemplate
        .replace(/\{nick\}/gi, order.nick)
        .replace(/\{amount\}/gi, amount);
}

function amountHints(order) {
    const n = Number(order.amount);
    const hints = [String(n), formatPayAmount(order.amount)];
    const suffix = config.paySuffix || '';
    if (suffix) {
        hints.push(`${n} ${suffix}`, `${n}${suffix}`, `${n} ${suffix}`.toUpperCase());
    }
    const mult = Number(config.payAmountMultiplier || 0);
    if (mult > 0) hints.push(String(Math.round(n * mult)));
    return [...new Set(hints.filter(Boolean).map((h) => h.toLowerCase()))];
}

function amountInMessage(text, order) {
    const lower = text.toLowerCase();
    return amountHints(order).some((h) => lower.includes(h));
}

/** Успех /pay — часто без ника в строке; галочка может быть ✔ или ✓ */
function isPaySuccessLine(text) {
    const plain = stripMcFormatting(text);
    const lower = plain.toLowerCase();
    const hasCheck = /[✔✓]/.test(plain) || /\[\s*[✔✓]\s*\]/.test(plain);
    if (lower.includes('успешно') && hasCheck) return true;
    if (PAY_SUCCESS_MARKERS.some((m) => lower.includes(m.toLowerCase()))) return true;
    if (
        lower.includes('успешно') &&
        (lower.includes('перевод') ||
            lower.includes('отправ') ||
            lower.includes('передан') ||
            lower.includes('/pay') ||
            lower.includes('pay '))
    ) {
        return true;
    }
    return false;
}

function messageMatchesOrder(text, order, kind) {
    if (isLobbyNoise(text)) return false;
    const hasNick = nickInMessage(text, order.nick);
    const hasAmount = amountInMessage(text, order);

    if (kind === 'fail') return hasNick || hasAmount;
    return hasNick;
}

function scheduleIdleQuit() {
    clearTimeout(idleQuitTimer);
    idleQuitTimer = setTimeout(() => {
        if (delivering || currentOrder || deliverQueue.length > 0) return;
        shutdownBot('idle');
    }, config.idleQuitMs);
}

function shutdownBot(reason) {
    clearTimeout(idleQuitTimer);
    healthCheckActive = false;
    ready = false;
    delivering = false;
    currentOrder = null;
    payOutcome = null;
    payFailReason = null;
    try {
        bot?.quit();
    } catch {
        /* ignore */
    }
    bot = null;
    log(`отключение (${reason})`);
    postEvent('shutdown', { reason });
    if (reason === 'banned' || reason === 'captcha') {
        setTimeout(() => process.exit(reason === 'banned' ? 2 : 3), 500);
    }
}

async function fetchBalanceLike4Narek() {
    if (!bot?.chat) return null;

    botState.balance = null;
    const deadline = Date.now() + config.balanceWaitMs;
    const cmdWait = config.balanceCmdWaitMs;

    log('проверка баланса: /balance…');

    while (botState.balance === null && Date.now() < deadline) {
        if (!healthCheckActive || !bot) return null;
        await antiAfkIfNeeded(bot, botState, log);
        bot.chat('/balance');
        await sleep(cmdWait);
    }

    if (botState.balance != null) {
        log(`баланс: ${botState.balance}`);
    } else {
        log('баланс: не ответил сервер');
    }
    return botState.balance;
}

function finishHealthCheck(status) {
    if (!healthCheckActive) return;
    healthCheckActive = false;
    clearTimeout(idleQuitTimer);
    log(`проверка завершена: ${status}`);
    postEvent('health_check', {
        status,
        balance: botState.balance ?? null,
    });
    if (status === 'banned') {
        parentPort.postMessage({ name: 'banned' });
    }
    if (status === 'captcha') {
        parentPort.postMessage(`${config.username} - ввести капчу (проверка)`);
    }
    if (status === 'interrupted') {
        processNextDeliver();
        return;
    }
    shutdownBot(status === 'ok' ? 'health_ok' : status);
}

/** Заказ важнее: проверку обрываем, бот на анархии остаётся для выдачи */
function abortHealthCheckForOrder() {
    if (!healthCheckActive) return false;
    log('проверка прервана — пришёл заказ');
    finishHealthCheck('interrupted');
    return true;
}

async function runHealthCheck() {
    if (delivering || deliverQueue.length > 0 || currentOrder) {
        postEvent('health_skipped', { reason: 'busy' });
        return;
    }

    healthCheckActive = true;
    log('проверка анархии: бан / капча…');

    try {
        if (bot && ready) {
            await fetchBalanceLike4Narek();
            if (botState.balance != null) {
                postEvent('health_balance', { balance: botState.balance });
            }
            const observe = config.healthCheckObserveMs;
            await sleep(observe);
            if (healthCheckActive) finishHealthCheck('ok');
            return;
        }
        await ensureBot();
    } catch (e) {
        healthCheckActive = false;
        log(`проверка: ошибка подключения — ${e.message}`);
        postEvent('health_check_failed', { reason: e.message });
        shutdownBot('health_fail');
    }
}

async function ensureBot() {
    if (bot || connecting) {
        while (connecting) await sleep(200);
        return bot;
    }

    connecting = true;
    log('подключение к серверу…');

    return new Promise((resolve, reject) => {
        const b = mineflayer.createBot({
            host: 'mc.funtime.su',
            port: 25565,
            username: config.username,
            password: config.password,
            version: '1.21.11',
            chatLengthLimit: 256,
        });

        b.on('scoreboardCreated', (scoreboard) => {
            if (JSON.stringify(scoreboard).includes(`${config.anarchy}`)) {
                log('scoreboard: на анархии');
            }
        });

        b.on('message', (message) => {
            const text = message.toString();
            chatLog.logServerMessage(text);
            void onServerChat(text);
        });

        b.on('resourcePack', (_url, hash) => {
            if (b._client) {
                b._client.write('resource_pack_receive', { uuid: hash.ascii, result: 0 });
            }
        });

        b.on('kicked', (reason) => {
            postEvent('kicked', { reason: JSON.stringify(reason) });
            shutdownBot('kicked');
            process.exit(1);
        });

        b.on('end', () => {
            if (bot === b) {
                bot = null;
                ready = false;
            }
        });

        b.once('spawn', async () => {
            try {
                log('spawn → /l → анархия');
                await sleep(1500);
                b.chat(`/l ${config.password}`);
                await sleep(2000);
                b.chat(anarchyCmd);
                await sleep(11000);
                bot = b;
                ready = true;
                connecting = false;
                postEvent('ready');
                if (healthCheckActive) {
                    log('на анархии — бан/капча/баланс');
                    await fetchBalanceLike4Narek();
                    if (botState.balance != null) {
                        postEvent('health_balance', { balance: botState.balance });
                    }
                    await sleep(config.healthCheckObserveMs);
                    if (healthCheckActive) finishHealthCheck('ok');
                    resolve(b);
                    return;
                }
                log('на анархии, готов к /pay');
                processNextDeliver();
                resolve(b);
            } catch (e) {
                connecting = false;
                reject(e);
            }
        });

        b.on('error', (err) => {
            connecting = false;
            reject(err);
        });
    });
}

function resetPayOutcome() {
    payOutcome = null;
    payFailReason = null;
}

/** Цикл /pay как safeAH в 4NAREK: antiAfk → команда → пауза → проверка успеха */
async function payDeliveryLoop() {
    const deadline = Date.now() + config.deliverTimeoutMs;
    const loopWait = config.payLoopWaitMs;
    let attempt = 0;

    while (delivering && currentOrder && Date.now() < deadline) {
        attempt += 1;

        if (payOutcome === 'ok') {
            finishDelivery('ok');
            return;
        }
        if (payOutcome === 'offline') {
            finishDelivery('offline');
            return;
        }
        if (payOutcome === 'invalid') {
            finishDelivery('invalid');
            return;
        }
        if (payOutcome === 'fail') {
            finishDelivery(payFailReason || 'fail');
            return;
        }

        if (botState.afk) {
            log(`AFK (круг ${attempt})`);
        }
        await antiAfkIfNeeded(bot, botState, log);

        if (botState.afk) {
            await sleep(loopWait);
            continue;
        }

        resetPayOutcome();
        const cmd = buildPayCommand(currentOrder);
        log(`/pay #${attempt}: ${cmd}`);
        bot.chat(cmd);

        await sleep(loopWait);

        if (payOutcome === 'ok') {
            finishDelivery('ok');
            return;
        }
        if (payOutcome === 'offline') {
            finishDelivery('offline');
            return;
        }
        if (payOutcome === 'invalid') {
            finishDelivery('invalid');
            return;
        }
        if (payOutcome === 'fail') {
            finishDelivery(payFailReason || 'fail');
            return;
        }
    }

    if (delivering && currentOrder) {
        log(`таймаут ${currentOrder.orderId}`);
        finishDelivery('timeout');
    }
}

function trySetPayOutcomeFromChat(text) {
    if (!delivering || !currentOrder) return;

    if (isPaySuccessLine(text)) {
        payOutcome = 'ok';
        logOk(`pay успех: ${text.slice(0, 80)}`);
        return;
    }
    if (matchesAny(text, config.offlineMarkers) && messageMatchesOrder(text, currentOrder, 'offline')) {
        payOutcome = 'offline';
        return;
    }
    if (matchesAny(text, config.invalidNickMarkers) && messageMatchesOrder(text, currentOrder, 'invalid')) {
        payOutcome = 'invalid';
        return;
    }
    if (matchesAny(text, config.failMarkers) && messageMatchesOrder(text, currentOrder, 'fail')) {
        payOutcome = 'fail';
        payFailReason = text.slice(0, 120);
    }
}

async function onServerChat(rawText) {
    const text = stripMcFormatting(rawText);

    if (text.includes(BANNED_MARKER)) {
        if (healthCheckActive) {
            finishHealthCheck('banned');
            return;
        }
        parentPort.postMessage({ name: 'banned' });
        finishDelivery('banned');
        shutdownBot('banned');
        return;
    }

    if (text.includes(CAPTCHA_MARKER)) {
        if (healthCheckActive) {
            finishHealthCheck('captcha');
            return;
        }
        parentPort.postMessage(`${config.username} - ввести капчу`);
        finishDelivery('captcha');
        shutdownBot('captcha');
        return;
    }

    if (text.includes(AFK_MARKER)) {
        botState.afk = true;
        log('сервер: режим AFK');
        return;
    }

    const balance = parseBalanceFromChat(text);
    if (balance != null) {
        botState.balance = balance;
    }

    trySetPayOutcomeFromChat(text);
}

const FATAL_DELIVERY = new Set(['banned', 'captcha']);

function finishDelivery(result) {
    if (!currentOrder) return;
    const orderId = currentOrder.orderId;
    const nick = currentOrder.nick;
    const amountKk = currentOrder.amount;
    const queued = deliverQueue.length;
    delivering = false;
    currentOrder = null;
    resetPayOutcome();

    if (result === 'ok') {
        void audit('game_pay_ok', { orderId, nick, amountKk });
        postEvent('delivery_ok', { orderId });
    }
    else if (result === 'offline') postEvent('player_offline', { orderId });
    else if (result === 'invalid_nick') postEvent('invalid_nick', { orderId });
    else if (result === 'banned') postEvent('delivery_failed', { orderId, reason: 'banned' });
    else if (result === 'captcha') postEvent('delivery_failed', { orderId, reason: 'captcha' });
    else if (result === 'timeout' && queued > 0) {
        postEvent('delivery_stalled', { orderId, reason: 'queue_timeout', queued });
    } else postEvent('delivery_failed', { orderId, reason: result || 'unknown' });

    if (FATAL_DELIVERY.has(result)) {
        deliverQueue.length = 0;
        return;
    }
    processNextDeliver();
}

function processNextDeliver() {
    clearTimeout(idleQuitTimer);
    if (healthCheckActive || delivering || !ready) return;
    const order = deliverQueue.shift();
    if (!order) {
        scheduleIdleQuit();
        return;
    }
    startDeliver(order);
}

async function startDeliver(order) {
    delivering = true;
    currentOrder = order;
    botState.afk = false;
    resetPayOutcome();
    log(`выдача ${order.orderId.slice(0, 8)}…: ${order.nick} ${order.amount}kk`);

    await payDeliveryLoop();
}

function isValidNick(nick) {
    return typeof nick === 'string' && /^[a-zA-Z0-9_]{3,16}$/.test(nick);
}

function orderSortKey(order) {
    return Number(order.paidAtMs) || 0;
}

function cancelOrderInWorker(orderId) {
    for (let i = deliverQueue.length - 1; i >= 0; i--) {
        if (deliverQueue[i].orderId === orderId) {
            deliverQueue.splice(i, 1);
            log(`очередь −1: отмена ${orderId.slice(0, 8)}…`);
        }
    }
    if (currentOrder?.orderId === orderId) {
        log(`прерывание выдачи: отмена ${orderId.slice(0, 8)}…`);
        delivering = false;
        currentOrder = null;
        resetPayOutcome();
        processNextDeliver();
    }
}

async function enqueueOrder(order) {
    if (!isValidNick(order?.nick)) {
        log(`пропуск ${order?.orderId}: нет ника`);
        return;
    }
    if (currentOrder?.orderId === order.orderId) return;
    if (deliverQueue.some((o) => o.orderId === order.orderId)) return;

    abortHealthCheckForOrder();

    const key = orderSortKey(order);
    let i = 0;
    while (i < deliverQueue.length && orderSortKey(deliverQueue[i]) <= key) i++;
    deliverQueue.splice(i, 0, order);
    log(`очередь ${deliverQueue.length}: ${order.orderId.slice(0, 8)}… ${order.nick} ${order.amount}kk`);

    clearTimeout(idleQuitTimer);
    try {
        await ensureBot();
        processNextDeliver();
    } catch (e) {
        log(`ошибка подключения: ${e.message}`);
        postEvent('connect_failed', { reason: e.message });
    }
}

log('воркер запущен');

parentPort.on('message', (data) => {
    if (data?.type === 'health_check') {
        void runHealthCheck();
        return;
    }
    if (data?.type === 'deliver' && data.order) {
        void enqueueOrder(data.order);
    }
    if (data?.type === 'cancel_order' && data.orderId) {
        cancelOrderInWorker(data.orderId);
    }
    if (data?.type === 'stop') {
        shutdownBot('stop');
        process.exit(0);
    }
});
