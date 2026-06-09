import mineflayer from 'mineflayer';
import { parentPort, workerData } from 'worker_threads';
import { antiAfkIfNeeded } from './lib/afk-look.mjs';
import { parseBalanceFromChat } from './lib/balance.mjs';
import { createChatLogger } from './lib/chat-log.mjs';
import { audit } from '../lib/audit.mjs';

// --- маркеры чата ---
const CLAN_INVITE_OK = '[⚔] Вы отправили приглашение в клан игроку';
const CLAN_JOIN_TAIL = ' присоединился к клану!';
const CLAN_INVEST_LINE = 'пополнил баланс казны';
const CLAN_WITHDRAW_MID = ' снял $';
const CLAN_WITHDRAW_TAIL = ' из казны';
const CLAN_OFFLINE_HEAD = '[⚔] Ошибка: Игрок';
const CLAN_OFFLINE_TAIL = ' не в сети!';
const AFK_MARKER = 'Данная команда недоступна в режиме AFK';
const CAPTCHA_MARKER = 'BotFilter >> Введите номер с картинки в чат';

const LMB = 0;
const SHIFT = 1;

const config = {
    username: workerData.username,
    password: workerData.password,
    anarchy: workerData.anarchy,
    clanInvestMultiplier: workerData.clanInvestMultiplier ?? 1_000_000,
    clanPhaseTimeoutMs: workerData.clanPhaseTimeoutMs ?? 60_000,
    clanLoopWaitMs: workerData.clanLoopWaitMs ?? 2000,
    clanClickDelayMinMs: workerData.clanClickDelayMinMs ?? 1500,
    clanClickDelayMaxMs: workerData.clanClickDelayMaxMs ?? 4500,
    clanMembersMenuSlot: workerData.clanMembersMenuSlot ?? 11,
    clanKickConfirmSlot: workerData.clanKickConfirmSlot ?? 0,
    anarchyRejoinWaitMs: workerData.anarchyRejoinWaitMs ?? 5000,
    idleQuitMs: workerData.idleQuitMs ?? 25_000,
    deliverTimeoutMs: workerData.deliverTimeoutMs ?? 600_000,
    balanceWaitMs: workerData.balanceWaitMs ?? 15_000,
    balanceCmdWaitMs: workerData.balanceCmdWaitMs ?? 2000,
    healthCheckObserveMs: workerData.healthCheckObserveMs ?? 8000,
    afk: false,
    balance: null,
    /** как botMenu в 4narek: что ждём от следующего windowOpen */
    menu: null,
};

const anarchyCmd = `/an${config.anarchy}`;

var bot = null;
let connecting = false;
let ready = false;
let delivering = false;
let currentOrder = null;
let idleQuitTimer = null;
let healthCheckActive = false;
let clanJoinedForCurrent = false;

const deliverQueue = [];

// флаги выдачи (из чата)
let inviteSent = false;
let playerJoined = false;
let moneyInvested = false;
let playerWithdrew = false;
let playerOffline = false;

// GUI: слот 11 — и кнопка «участники», и голова игрока в списке
let guiBusy = false;
let permsDone = false;
let kickDone = false;

const { logInfo, logOk, logServerMessage } = createChatLogger(config.username);

function post(name, extra = {}) {
    parentPort.postMessage({ name, ...extra });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function rnd(min, max) {
    await sleep(min + Math.floor(Math.random() * (max - min + 1)));
}

async function rndClick() {
    await rnd(config.clanClickDelayMinMs, config.clanClickDelayMaxMs);
}

function plain(text) {
    return String(text).replace(/§./g, '').replace(/&[0-9a-fk-or]/gi, '');
}

function nickIn(text, nick) {
    const esc = String(nick).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc}\\b`, 'i').test(text);
}

function investSum(kk) {
    return String(Math.round(Number(kk) * config.clanInvestMultiplier));
}

function resetDeliveryFlags() {
    inviteSent = false;
    playerJoined = false;
    moneyInvested = false;
    playerWithdrew = false;
    playerOffline = false;
    clanJoinedForCurrent = false;
}

function resetGui() {
    config.menu = null;
    guiBusy = false;
    permsDone = false;
    kickDone = false;
}

async function closeWindow() {
    if (!bot?.currentWindow) return;
    try {
        await bot.closeWindow(bot.currentWindow);
    } catch { /* */ }
    await rnd(300, 500);
}

// ========== чат ==========

function handleChatMessage(raw) {
    const text = plain(raw);

    if (text.includes('вы забанены')) {
        if (healthCheckActive) return finishHealth('banned');
        parentPort.postMessage(`${config.username} - забанен`);
        endDelivery('banned');
        shutdown('banned');
        return;
    }

    if (text.includes(CAPTCHA_MARKER)) {
        if (healthCheckActive) return finishHealth('captcha');
        parentPort.postMessage(`${config.username} - ввести капчу`);
        endDelivery('captcha');
        shutdown('captcha');
        return;
    }

    if (text.includes(AFK_MARKER)) {
        config.afk = true;
        logInfo('сервер: режим AFK');
        return;
    }

    const bal = parseBalanceFromChat(text);
    if (bal != null) config.balance = bal;

    if (!delivering || !currentOrder?.nick) return;
    const nick = currentOrder.nick;

    if (text.includes(CLAN_INVITE_OK)) {
        inviteSent = true;
        logOk('invite отправлен');
        return;
    }

    if (text.includes('[⚔] Игрок') && text.includes(CLAN_JOIN_TAIL) && nickIn(text, nick)) {
        playerJoined = true;
        clanJoinedForCurrent = true;
        logOk(`join: ${nick}`);
        post('clan_joined', { orderId: currentOrder.orderId, nick });
        return;
    }

    // [X] Кланы: <бот> пополнил баланс казны
    if (text.includes('Кланы:') && text.includes(CLAN_INVEST_LINE) && nickIn(text, config.username)) {
        moneyInvested = true;
        logOk(`invest: ${config.username}`);
        return;
    }

    // [X] Игрок <ник> снял $... из казны
    if (text.includes('Игрок') && text.includes(CLAN_WITHDRAW_MID) && text.includes(CLAN_WITHDRAW_TAIL) && nickIn(text, nick)) {
        playerWithdrew = true;
        logOk(`withdraw: ${nick}`);
        return;
    }

    if (text.includes(CLAN_OFFLINE_HEAD) && text.includes(CLAN_OFFLINE_TAIL) && nickIn(text, nick)) {
        playerOffline = true;
        logInfo(`offline: ${nick}`);
    }
}

// ========== GUI (windowOpen) ==========

async function onWindowOpen() {
    if (!bot?.currentWindow || config.menu == null || guiBusy) return;

    guiBusy = true;
    const slot = config.clanMembersMenuSlot;
    logInfo(`windowOpen → ${config.menu}`);

    try {
        switch (config.menu) {
            // окно 1: /clan menu → один клик → откроется участники
            case 'clan_menu':
                await rndClick();
                if (!bot.currentWindow) break;
                logInfo(`клик слот ${slot}`);
                config.menu = 'clan_members';
                await bot.clickWindow(slot, LMB, 0);
                break;

            // окно 2: участники → shift×1 → откроется права
            case 'clan_members':
                await rndClick();
                if (!bot.currentWindow) break;
                logInfo(`shift×1 слот ${slot}`);
                config.menu = 'clan_shift2';
                await bot.clickWindow(slot, LMB, SHIFT);
                break;

            // окно 3: права → shift×2 → готово
            case 'clan_shift2':
                await rndClick();
                if (!bot.currentWindow) break;
                logInfo(`shift×2 слот ${slot}`);
                config.menu = null;
                permsDone = true;
                await bot.clickWindow(slot, LMB, SHIFT);
                break;

            // kick confirm → один клик
            case 'clan_kick':
                await rndClick();
                if (!bot.currentWindow) break;
                logInfo(`kick confirm слот ${config.clanKickConfirmSlot}`);
                config.menu = null;
                kickDone = true;
                await bot.clickWindow(config.clanKickConfirmSlot, LMB, 0);
                break;
        }
    } finally {
        guiBusy = false;
    }
}

async function grantWithdrawPerms(_nick, deadline) {
    while (Date.now() < deadline) {
        permsDone = false;
        config.menu = 'clan_menu';
        await closeWindow();
        logInfo('/clan menu');
        bot.chat('/clan menu');

        const roundEnd = Math.min(deadline, Date.now() + 12_000);
        while (Date.now() < roundEnd && !permsDone) {
            await sleep(400);
            if (!bot?.currentWindow) await antiAfkIfNeeded(bot, config, logInfo);
        }

        if (permsDone) {
            await rnd(1500, 3500);
            await closeWindow();
            logOk('права withdraw выданы');
            return true;
        }
        logInfo('права — повтор');
        await sleep(config.clanLoopWaitMs);
    }
    config.menu = null;
    return false;
}

async function kickFromClan(nick, deadline) {
    const cmd = `/clan kick ${nick}`;
    while (Date.now() < deadline) {
        kickDone = false;
        config.menu = 'clan_kick';
        await closeWindow();
        logInfo(cmd);
        bot.chat(cmd);

        const roundEnd = Math.min(deadline, Date.now() + 12_000);
        while (Date.now() < roundEnd && !kickDone) {
            await sleep(400);
            if (!bot?.currentWindow) await antiAfkIfNeeded(bot, config, logInfo);
        }

        if (kickDone) {
            await sleep(800);
            await closeWindow();
            return true;
        }
        logInfo('kick — повтор');
        await sleep(config.clanLoopWaitMs);
    }
    config.menu = null;
    return false;
}

// ========== баланс ==========

async function safeBalance(waitMs = config.balanceWaitMs) {
    if (!bot?.chat) return null;
    config.balance = null;
    const deadline = Date.now() + waitMs;
    logInfo('/balance…');
    while (config.balance == null && Date.now() < deadline) {
        if (!bot) return null;
        await antiAfkIfNeeded(bot, config, logInfo);
        bot.chat('/balance');
        await sleep(config.balanceCmdWaitMs);
    }
    if (config.balance != null) logInfo(`баланс: ${config.balance}`);
    return config.balance;
}

// ========== бот ==========

function wireBot(b) {
    b.on('message', (msg) => {
        const t = msg.toString();
        logServerMessage(t);
        handleChatMessage(t);
    });

    b.on('resourcePack', (_u, hash) => {
        b._client?.write('resource_pack_receive', { uuid: hash.ascii, result: 0 });
    });

    b.on('windowOpen', () => void onWindowOpen());

    b.on('kicked', (reason) => {
        post('kicked', { reason: JSON.stringify(reason) });
        shutdown('kicked');
        process.exit(1);
    });

    b.on('end', () => {
        if (bot === b) {
            bot = null;
            ready = false;
        }
        process.exit(1);
    });

    b.on('error', () => process.exit(1));
}

async function connectBot() {
    if (bot) return bot;
    if (connecting) {
        while (connecting) await sleep(200);
        return bot;
    }

    connecting = true;
    logInfo('подключение…');

    return new Promise((resolve, reject) => {
        const b = mineflayer.createBot({
            host: 'mc.funtime.su',
            port: 25565,
            username: config.username,
            password: config.password,
            version: '1.21.11',
            chatLengthLimit: 256,
        });

        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            connecting = false;
            try { b.quit(); } catch { /* */ }
            reject(new Error('таймаут spawn'));
        }, 45_000);

        const done = (err, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            connecting = false;
            if (err) reject(err);
            else resolve(result);
        };

        wireBot(b);

        b.once('spawn', async () => {
            try {
                logInfo('spawn → /l → /an');
                await sleep(1500);
                b.chat(`/l ${config.password}`);
                await sleep(2000);
                b.chat(anarchyCmd);
                await sleep(11_000);

                bot = b;
                ready = true;
                post('ready');

                if (healthCheckActive) {
                    await safeBalance();
                    if (config.balance != null) post('health_balance', { balance: config.balance });
                    await sleep(config.healthCheckObserveMs);
                    if (healthCheckActive) finishHealth('ok');
                    done(null, b);
                    return;
                }

                logOk('готов к выдаче');
                nextOrder();
                done(null, b);
            } catch (e) {
                done(e);
            }
        });
    });
}

function shutdown(reason) {
    clearTimeout(idleQuitTimer);
    healthCheckActive = false;
    ready = false;
    delivering = false;
    currentOrder = null;
    resetDeliveryFlags();
    resetGui();
    try { bot?.quit(); } catch { /* */ }
    bot = null;
    logInfo(`отключение (${reason})`);
    post('shutdown', { reason });
    if (reason === 'banned' || reason === 'captcha') {
        setTimeout(() => process.exit(reason === 'banned' ? 2 : 3), 500);
    }
}

// ========== выдача ==========

async function deliverClan() {
    const order = currentOrder;
    const nick = order.nick;
    const invest = investSum(order.amount);
    const orderEnd = Date.now() + config.deliverTimeoutMs;
    const active = () => delivering && currentOrder?.orderId === order.orderId;
    const phaseEnd = () => Date.now() + config.clanPhaseTimeoutMs;

    // 0. баланс
    const balance = await safeBalance();
    if (!active()) return;
    if (balance == null || balance < Number(invest)) {
        logInfo(`мало денег: ${balance ?? '?'} < ${invest}`);
        endDelivery('insufficient_funds');
        return;
    }

    // 1. invite
    logInfo(`invite ${nick}, invest ${invest}`);
    resetDeliveryFlags();
    let end = phaseEnd();
    while (active() && Date.now() < orderEnd && Date.now() < end && !inviteSent) {
        if (playerOffline) { endDelivery('offline'); return; }
        await antiAfkIfNeeded(bot, config, logInfo);
        if (config.afk) { await sleep(config.clanLoopWaitMs); continue; }
        await closeWindow();
        bot.chat(`/clan invite ${nick}`);
        await sleep(config.clanLoopWaitMs);
    }
    if (!active()) return;
    if (!inviteSent) { endDelivery('timeout'); return; }
    post('clan_invite_sent', { orderId: order.orderId, nick });

    // 2. join
    logInfo(`ждём join ${nick}`);
    end = Math.min(phaseEnd(), orderEnd);
    while (active() && Date.now() < end && !playerJoined) {
        if (playerOffline) { endDelivery('offline'); return; }
        await antiAfkIfNeeded(bot, config, logInfo);
        await sleep(400);
    }
    if (!active()) return;
    if (!playerJoined) {
        await kickFromClan(nick, phaseEnd());
        endDelivery('timeout');
        return;
    }

    // 3. права withdraw (GUI)
    logInfo('права withdraw…');
    end = phaseEnd();
    let perms = false;
    while (active() && Date.now() < end && !perms) {
        perms = await grantWithdrawPerms(nick, end);
        if (!perms) await sleep(config.clanLoopWaitMs);
    }
    if (!active()) return;
    if (!perms) {
        await kickFromClan(nick, phaseEnd());
        endDelivery('timeout');
        return;
    }

    // 4. invest — ждём строку в чате, как invite / withdraw
    logInfo(`invest ${invest}`);
    moneyInvested = false;
    end = phaseEnd();
    while (active() && Date.now() < end && !moneyInvested) {
        await antiAfkIfNeeded(bot, config, logInfo);
        if (config.afk) { await sleep(config.clanLoopWaitMs); continue; }
        await closeWindow();
        bot.chat(`/clan invest ${invest}`);
        await sleep(config.clanLoopWaitMs);
    }
    if (!active()) return;
    if (!moneyInvested) {
        await kickFromClan(nick, phaseEnd());
        endDelivery('timeout');
        return;
    }
    post('clan_invested', { orderId: order.orderId, nick, investAmount: invest, amountKk: order.amount });

    // 5. withdraw — игрок один раз /clan withdraw
    logInfo(`ждём withdraw ${nick}`);
    end = phaseEnd();
    while (active() && Date.now() < end && !playerWithdrew) {
        await antiAfkIfNeeded(bot, config, logInfo);
        await sleep(400);
    }
    if (!active()) return;
    if (!playerWithdrew) {
        await kickFromClan(nick, phaseEnd());
        endDelivery('timeout', deliverQueue.length);
        return;
    }

    // 6. kick
    await kickFromClan(nick, phaseEnd());
    if (!active()) return;
    endDelivery('ok');
}

const FATAL = new Set(['banned', 'captcha']);

function endDelivery(result, queued) {
    if (!currentOrder) return;
    const { orderId, nick, amount: amountKk } = currentOrder;
    const q = queued ?? deliverQueue.length;
    delivering = false;
    currentOrder = null;
    resetDeliveryFlags();
    resetGui();

    if (result === 'ok') {
        void audit('game_clan_ok', { orderId, nick, amountKk });
        post('delivery_ok', { orderId });
    } else if (result === 'offline') {
        post('player_offline', { orderId });
    } else if (result === 'insufficient_funds') {
        post('insufficient_funds', { orderId });
    } else if (result === 'banned') {
        post('delivery_failed', { orderId, reason: 'banned' });
    } else if (result === 'captcha') {
        post('delivery_failed', { orderId, reason: 'captcha' });
    } else if (result === 'timeout' && q > 0) {
        post('delivery_stalled', { orderId, reason: 'clan_withdraw_timeout', queued: q });
    } else if (result === 'timeout') {
        post('delivery_stalled', { orderId, reason: 'clan_timeout', queued: q });
    } else {
        post('delivery_failed', { orderId, reason: result || 'unknown' });
    }

    if (FATAL.has(result)) {
        deliverQueue.length = 0;
        return;
    }
    nextOrder();
}

async function startDeliver(order) {
    delivering = true;
    currentOrder = order;
    config.afk = false;
    resetDeliveryFlags();
    logInfo(`выдача ${order.orderId.slice(0, 8)}… ${order.nick} ${order.amount}kk`);

    try {
        await closeWindow();
        await antiAfkIfNeeded(bot, config, logInfo);
        bot.chat(anarchyCmd);
        await sleep(config.anarchyRejoinWaitMs);

        await deliverClan();
    } catch (e) {
        logInfo(`crash: ${e.message}`);
        await kickFromClan(order.nick, Date.now() + config.clanPhaseTimeoutMs);
        endDelivery('delivery_loop_crash');
    }
}

function nextOrder() {
    clearTimeout(idleQuitTimer);
    if (healthCheckActive || delivering || !ready) return;

    const order = deliverQueue.shift();
    if (!order) {
        idleQuitTimer = setTimeout(() => {
            if (!delivering && !currentOrder && deliverQueue.length === 0) shutdown('idle');
        }, config.idleQuitMs);
        return;
    }
    void startDeliver(order);
}

// ========== health ==========

function finishHealth(status) {
    if (!healthCheckActive) return;
    healthCheckActive = false;
    logInfo(`health: ${status}`);
    post('health_check', { status, balance: config.balance ?? null });
    if (status === 'banned') parentPort.postMessage({ name: 'banned' });
    if (status === 'captcha') parentPort.postMessage(`${config.username} - ввести капчу (проверка)`);
    if (status === 'interrupted') return nextOrder();
    shutdown(status === 'ok' ? 'health_ok' : status);
}

async function runHealthCheck() {
    if (delivering || deliverQueue.length || currentOrder) {
        post('health_skipped', { reason: 'busy' });
        return;
    }
    healthCheckActive = true;
    try {
        if (bot && ready) {
            await safeBalance();
            if (config.balance != null) post('health_balance', { balance: config.balance });
            await sleep(config.healthCheckObserveMs);
            if (healthCheckActive) finishHealth('ok');
            return;
        }
        await connectBot();
    } catch (e) {
        healthCheckActive = false;
        post('health_check_failed', { reason: e.message });
        shutdown('health_fail');
    }
}

// ========== очередь ==========

async function addOrder(order) {
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(order?.nick || '')) {
        logInfo(`пропуск — плохой ник`);
        return;
    }
    if (currentOrder?.orderId === order.orderId) return;
    if (deliverQueue.some((o) => o.orderId === order.orderId)) return;

    if (healthCheckActive) {
        logInfo('health прерван — заказ');
        finishHealth('interrupted');
    }

    const t = Number(order.paidAtMs) || 0;
    let i = 0;
    while (i < deliverQueue.length && (Number(deliverQueue[i].paidAtMs) || 0) <= t) i++;
    deliverQueue.splice(i, 0, order);
    logInfo(`очередь ${deliverQueue.length}: ${order.nick} ${order.amount}kk`);

    clearTimeout(idleQuitTimer);
    try {
        await connectBot();
        nextOrder();
    } catch (e) {
        post('connect_failed', { reason: e.message });
    }
}

function cancelOrder(orderId) {
    for (let i = deliverQueue.length - 1; i >= 0; i--) {
        if (deliverQueue[i].orderId === orderId) deliverQueue.splice(i, 1);
    }
    if (currentOrder?.orderId !== orderId) return;
    const nick = currentOrder.nick;
    void kickFromClan(nick, Date.now() + config.clanPhaseTimeoutMs).finally(() => {
        delivering = false;
        currentOrder = null;
        resetDeliveryFlags();
        nextOrder();
    });
}

// ========== старт ==========

logInfo('воркер (клан)');

parentPort.on('message', (data) => {
    if (data?.type === 'health_check') void runHealthCheck();
    if (data?.type === 'deliver' && data.order) void addOrder(data.order);
    if (data?.type === 'cancel_order' && data.orderId) cancelOrder(data.orderId);
    if (data?.type === 'stop') { shutdown('stop'); process.exit(0); }
});
