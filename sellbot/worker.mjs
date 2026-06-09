import mineflayer from 'mineflayer';
import { parentPort, workerData } from 'worker_threads';
import { antiAfkIfNeeded } from './lib/afk-look.mjs';
import { parseBalanceFromChat } from './lib/balance.mjs';
import { createChatLogger } from './lib/chat-log.mjs';
import { audit } from '../lib/audit.mjs';
import {
    closeWindowSafe,
    formatClanInvestAmount,
    isClanInviteSentLine,
    isClanJoinedLine,
    isClanPlayerOfflineLine,
    isClanWithdrawLine,
    safeClanChatLoop,
    stripMcFormatting,
} from './lib/clan-delivery.mjs';
import {
    attachClanGuiHandler,
    createClanGuiState,
    resetClanGuiState,
    runGrantWithdrawPerms,
    runKickFromClan,
} from './lib/clan-gui.mjs';

const config = {
    username: workerData.username,
    password: workerData.password,
    anarchy: workerData.anarchy,
    deliveryMode: workerData.deliveryMode || 'clan',
    clanInvestMultiplier: workerData.clanInvestMultiplier ?? 1_000_000,
    clanPhaseTimeoutMs: workerData.clanPhaseTimeoutMs ?? 60_000,
    clanLoopWaitMs: workerData.clanLoopWaitMs ?? 2000,
    clanClickDelayMinMs: workerData.clanClickDelayMinMs ?? 1500,
    clanClickDelayMaxMs: workerData.clanClickDelayMaxMs ?? 4500,
    clanMembersMenuSlot: workerData.clanMembersMenuSlot ?? 11,
    clanKickConfirmSlot: workerData.clanKickConfirmSlot ?? 0,
    /** Пауза после /an перед выдачей (мс) */
    anarchyRejoinWaitMs: workerData.anarchyRejoinWaitMs ?? 5000,
    idleQuitMs: workerData.idleQuitMs ?? 25_000,
    deliverTimeoutMs: workerData.deliverTimeoutMs ?? 600_000,
    balanceWaitMs: workerData.balanceWaitMs ?? 15_000,
    balanceCmdWaitMs: workerData.balanceCmdWaitMs ?? 2000,
    healthCheckObserveMs: workerData.healthCheckObserveMs ?? 8000,
};

const anarchyCmd = `/an${config.anarchy}`;
const AFK_MARKER = 'Данная команда недоступна в режиме AFK';
const CAPTCHA_MARKER = 'BotFilter >> Введите номер с картинки в чат';

const botState = { afk: false, balance: null };
const clanGuiState = createClanGuiState();
const deliverQueue = [];

/** Флаги текущей выдачи — выставляются из чата */
const clanChatFlags = {
    inviteSent: false,
    joined: false,
    withdrew: false,
    offline: false,
};

let bot = null;
let connecting = false;
let ready = false;
let delivering = false;
let currentOrder = null;
let idleQuitTimer = null;
let healthCheckActive = false;
/** После join — игнорировать смену ника */
let clanJoinedForCurrent = false;

const chatLog = createChatLogger(config.username);
const log = (msg) => chatLog.logInfo(msg);
const logOk = (msg) => chatLog.logOk(msg);

function postEvent(name, extra = {}) {
    parentPort.postMessage({ name, ...extra });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function resetClanChatFlags() {
    clanChatFlags.inviteSent = false;
    clanChatFlags.joined = false;
    clanChatFlags.withdrew = false;
    clanChatFlags.offline = false;
    clanJoinedForCurrent = false;
}

function phaseDeadlineMs() {
    return Date.now() + config.clanPhaseTimeoutMs;
}

function investAmountForOrder(order) {
    return formatClanInvestAmount(order.amount, config.clanInvestMultiplier);
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
    resetClanChatFlags();
    resetClanGuiState(clanGuiState);
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

async function fetchBalance(deadlineMs = config.balanceWaitMs) {
    if (!bot?.chat) return null;

    botState.balance = null;
    const deadline = Date.now() + deadlineMs;
    const cmdWait = config.balanceCmdWaitMs;

    log('проверка баланса: /balance…');

    while (botState.balance === null && Date.now() < deadline) {
        if (!bot) return null;
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

async function fetchBalanceLike4Narek() {
    if (!healthCheckActive || !bot) return null;
    return fetchBalance(config.balanceWaitMs);
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
            await sleep(config.healthCheckObserveMs);
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

        let done = false;
        const connectTimeout = setTimeout(() => {
            if (done) return;
            done = true;
            connecting = false;
            try {
                b.quit();
            } catch {
                /* ignore */
            }
            reject(new Error('таймаут подключения до spawn'));
        }, 45_000);

        function fail(err) {
            if (done) return;
            done = true;
            clearTimeout(connectTimeout);
            connecting = false;
            reject(err instanceof Error ? err : new Error(String(err)));
        }

        function ok() {
            if (done) return;
            done = true;
            clearTimeout(connectTimeout);
            connecting = false;
            resolve(b);
        }

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
            fail(new Error(`kicked: ${JSON.stringify(reason)}`));
            shutdownBot('kicked');
            process.exit(1);
        });

        b.on('end', () => {
            if (!done) {
                fail(new Error('соединение закрыто до spawn'));
            }
            if (bot === b) {
                bot = null;
                ready = false;
            }
            process.exit(1);
        });

        b.once('spawn', async () => {
            try {
                log('spawn → /l → анархия');
                await sleep(1500);
                b.chat(`/l ${config.password}`);
                await sleep(2000);
                b.chat(anarchyCmd);
                await sleep(11_000);
                bot = b;
                ready = true;
                attachClanGuiHandler(bot, clanGuiState, config, log);
                postEvent('ready');
                if (healthCheckActive) {
                    log('на анархии — бан/капча/баланс');
                    await fetchBalanceLike4Narek();
                    if (botState.balance != null) {
                        postEvent('health_balance', { balance: botState.balance });
                    }
                    await sleep(config.healthCheckObserveMs);
                    if (healthCheckActive) finishHealthCheck('ok');
                    ok();
                    return;
                }
                log('на анархии, готов к выдаче через клан');
                processNextDeliver();
                ok();
            } catch (e) {
                fail(e);
            }
        });

        b.on('error', (err) => {
            fail(err);
            process.exit(1);
        });
    });
}

function handleClanChatDuringDelivery(text, nick) {
    if (isClanInviteSentLine(text)) {
        clanChatFlags.inviteSent = true;
        logOk(`clan invite отправлен`);
        return;
    }
    if (isClanJoinedLine(text, nick)) {
        clanChatFlags.joined = true;
        clanJoinedForCurrent = true;
        logOk(`clan join: ${nick}`);
        postEvent('clan_joined', { orderId: currentOrder.orderId, nick });
        return;
    }
    if (isClanWithdrawLine(text, nick)) {
        clanChatFlags.withdrew = true;
        logOk(`clan withdraw: ${nick}`);
        return;
    }
    if (isClanPlayerOfflineLine(text, nick)) {
        clanChatFlags.offline = true;
        log(`clan offline: ${nick}`);
    }
}

async function onServerChat(rawText) {
    const text = stripMcFormatting(rawText);

    if (text.includes('вы забанены')) {
        if (healthCheckActive) {
            finishHealthCheck('banned');
            return;
        }
        parentPort.postMessage(`${config.username} - забанен`);
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

    if (delivering && currentOrder?.nick) {
        handleClanChatDuringDelivery(text, currentOrder.nick);
    }
}

async function waitUntilFlag(flagName, deadline) {
    while (delivering && currentOrder && Date.now() < deadline) {
        if (clanChatFlags[flagName]) return true;
        if (flagName !== 'offline' && clanChatFlags.offline) return false;
        await antiAfkIfNeeded(bot, botState, log);
        await sleep(400);
    }
    return clanChatFlags[flagName];
}

async function tryKickCurrent(nick, deadline) {
    if (!nick || !bot) return;
    log(`clan kick: ${nick}`);
    await runKickFromClan(bot, botState, clanGuiState, config, log, nick, deadline);
}

/**
 * Выдача через клан: invite → join → perms → invest → withdraw → kick.
 */
async function clanDeliveryLoop() {
    const order = currentOrder;
    const nick = order.nick;
    const investRaw = investAmountForOrder(order);
    const orderDeadline = Date.now() + config.deliverTimeoutMs;
    let inviteSentEvent = false;
    let investEvent = false;

    const ensureOrderActive = () => delivering && currentOrder?.orderId === order.orderId;

    // [0] Баланс перед invite
    const balance = await fetchBalance();
    if (!ensureOrderActive()) return;
    const need = Number(investRaw);
    if (balance == null || balance < need) {
        log(`недостаточно баланса: ${balance ?? '?'} < ${need}`);
        finishDelivery('insufficient_funds');
        return;
    }

    // [1] /clan invite
    log(`clan invite → ${nick}, invest ${investRaw}`);
    resetClanChatFlags();
    let phaseEnd = phaseDeadlineMs();

    while (ensureOrderActive() && Date.now() < orderDeadline && Date.now() < phaseEnd) {
        if (clanChatFlags.inviteSent) break;
        if (clanChatFlags.offline) {
            finishDelivery('offline');
            return;
        }

        const r = await safeClanChatLoop(bot, botState, log, `/clan invite ${nick}`, {
            untilOk: () => clanChatFlags.inviteSent,
            untilOffline: () => clanChatFlags.offline,
            deadline: phaseEnd,
            loopWaitMs: config.clanLoopWaitMs,
        });

        if (clanChatFlags.offline || r === 'offline') {
            finishDelivery('offline');
            return;
        }
        if (clanChatFlags.inviteSent) break;
    }

    if (!ensureOrderActive()) return;
    if (!clanChatFlags.inviteSent) {
        log('clan invite: таймаут');
        finishDelivery('timeout');
        return;
    }

    if (!inviteSentEvent) {
        inviteSentEvent = true;
        postEvent('clan_invite_sent', { orderId: order.orderId, nick });
    }

    // [2] Ждём join
    phaseEnd = phaseDeadlineMs();
    log(`clan join: ждём ${nick}…`);
    const joined = await waitUntilFlag('joined', Math.min(phaseEnd, orderDeadline));
    if (!ensureOrderActive()) return;
    if (!joined) {
        log('clan join: таймаут');
        await tryKickCurrent(nick, phaseDeadlineMs());
        finishDelivery('timeout');
        return;
    }

    // [3] Права withdraw через GUI
    phaseEnd = phaseDeadlineMs();
    log('clan menu: выдача прав…');
    let permsOk = false;
    while (ensureOrderActive() && Date.now() < phaseEnd && !permsOk) {
        permsOk = await runGrantWithdrawPerms(
            bot,
            botState,
            clanGuiState,
            config,
            log,
            nick,
            phaseEnd,
        );
        if (!permsOk) {
            await antiAfkIfNeeded(bot, botState, log);
            await sleep(config.clanLoopWaitMs);
        }
    }
    if (!ensureOrderActive()) return;
    if (!permsOk) {
        log('clan menu: таймаут прав');
        await tryKickCurrent(nick, phaseDeadlineMs());
        finishDelivery('timeout');
        return;
    }

    // [4] /clan invest (без маркера в чате — шлём из цикла с anti-AFK)
    phaseEnd = phaseDeadlineMs();
    log(`clan invest ${investRaw}`);
    let investSent = false;
    while (ensureOrderActive() && Date.now() < phaseEnd && !investSent) {
        await antiAfkIfNeeded(bot, botState, log);
        if (botState.afk) {
            await sleep(config.clanLoopWaitMs);
            continue;
        }
        try {
            await closeWindowSafe(bot);
            bot.chat(`/clan invest ${investRaw}`);
            investSent = true;
        } catch (e) {
            log(`clan invest fail: ${e.message}`);
            await sleep(config.clanLoopWaitMs);
        }
    }
    if (!ensureOrderActive()) return;
    if (!investSent) {
        log('clan invest: таймаут');
        await tryKickCurrent(nick, phaseDeadlineMs());
        finishDelivery('timeout');
        return;
    }
    await sleep(config.clanLoopWaitMs);

    if (!investEvent) {
        investEvent = true;
        postEvent('clan_invested', {
            orderId: order.orderId,
            nick,
            investAmount: investRaw,
            amountKk: order.amount,
        });
    }

    // [5] Ждём withdraw (сумму не проверяем — только ник в строке)
    phaseEnd = phaseDeadlineMs();
    log(`clan withdraw: ждём ${nick}…`);
    while (ensureOrderActive() && Date.now() < phaseEnd && !clanChatFlags.withdrew) {
        await antiAfkIfNeeded(bot, botState, log);
        await sleep(400);
    }

    if (!ensureOrderActive()) return;
    if (!clanChatFlags.withdrew) {
        log('clan withdraw: таймаут');
        await tryKickCurrent(nick, phaseDeadlineMs());
        const queued = deliverQueue.length;
        if (queued > 0) {
            finishDelivery('timeout', { queued });
        } else {
            finishDelivery('timeout');
        }
        return;
    }

    // [6] Kick после успешного withdraw
    phaseEnd = phaseDeadlineMs();
    await tryKickCurrent(nick, phaseEnd);

    if (!ensureOrderActive()) return;
    finishDelivery('ok');
}

const FATAL_DELIVERY = new Set(['banned', 'captcha']);

function finishDelivery(result, { skipQueue = false, queued } = {}) {
    if (!currentOrder) return;
    const orderId = currentOrder.orderId;
    const nick = currentOrder.nick;
    const amountKk = currentOrder.amount;
    const queueLen = queued ?? deliverQueue.length;
    delivering = false;
    currentOrder = null;
    resetClanChatFlags();
    resetClanGuiState(clanGuiState);

    if (result === 'ok') {
        void audit('game_clan_ok', { orderId, nick, amountKk });
        postEvent('delivery_ok', { orderId });
    } else if (result === 'offline') {
        postEvent('player_offline', { orderId });
    } else if (result === 'insufficient_funds') {
        postEvent('insufficient_funds', { orderId });
    } else if (result === 'banned') {
        postEvent('delivery_failed', { orderId, reason: 'banned' });
    } else if (result === 'captcha') {
        postEvent('delivery_failed', { orderId, reason: 'captcha' });
    } else if (result === 'timeout' && queueLen > 0) {
        postEvent('delivery_stalled', { orderId, reason: 'clan_withdraw_timeout', queued: queueLen });
    } else if (result === 'timeout') {
        postEvent('delivery_stalled', { orderId, reason: 'clan_timeout', queued: queueLen });
    } else {
        postEvent('delivery_failed', { orderId, reason: result || 'unknown' });
    }

    if (skipQueue || FATAL_DELIVERY.has(result)) {
        if (!skipQueue) deliverQueue.length = 0;
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

async function ensureOnAnarchyBeforeOrder() {
    if (!bot?.chat) return false;

    await closeWindowSafe(bot);
    await antiAfkIfNeeded(bot, botState, log);

    if (botState.afk) {
        log('AFK перед заказом — повтор после осмотра');
        await sleep(config.clanLoopWaitMs);
    }

    log(`${anarchyCmd} (перед заказом)`);
    try {
        bot.chat(anarchyCmd);
    } catch (e) {
        log(`anarchy cmd fail: ${e.message}`);
        return false;
    }

    const waitMs = Number(config.anarchyRejoinWaitMs) || 5000;
    await sleep(waitMs);
    return true;
}

async function startDeliver(order) {
    delivering = true;
    currentOrder = order;
    botState.afk = false;
    resetClanChatFlags();
    log(`выдача ${order.orderId.slice(0, 8)}…: ${order.nick} ${order.amount}kk (клан)`);

    try {
        if (!(await ensureOnAnarchyBeforeOrder())) {
            finishDelivery('disconnected');
            return;
        }
        await clanDeliveryLoop();
    } catch (e) {
        log(`clan delivery crash: ${e.message}`);
        const nick = order.nick;
        await tryKickCurrent(nick, phaseDeadlineMs());
        finishDelivery('delivery_loop_crash');
    }
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
        const nick = currentOrder.nick;
        void tryKickCurrent(nick, phaseDeadlineMs()).finally(() => {
            delivering = false;
            currentOrder = null;
            resetClanChatFlags();
            processNextDeliver();
        });
    }
}

async function enqueueOrder(order) {
    if (!isValidNick(order?.nick)) {
        log(`пропуск ${order?.orderId}: нет ника`);
        return;
    }

    if (currentOrder?.orderId === order.orderId) {
        if (clanJoinedForCurrent) {
            log(`ник игнор — ${order.nick} уже в клане`);
        }
        return;
    }

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

log('воркер запущен (режим: клан)');

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
