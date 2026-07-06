import mineflayer from 'mineflayer';
import { parentPort, workerData } from 'worker_threads';
import { antiAfkIfNeeded, lookAroundSpin } from './lib/afk-look.mjs';
import {
    parseBalanceFromChat,
    parseClanBalanceFromChat,
    parseClanWithdrawAmount,
} from './lib/balance.mjs';
import {
    parseClanMembersFromChat,
    findClanIntruders,
} from './lib/clan-members.mjs';
import { createChatLogger } from './lib/chat-log.mjs';
import { buildMcProxyConnect, readBotJsonProxy, maskProxyUrl } from './lib/mc-proxy.mjs';
import {
    setupConfigurationTransferFix,
    isInConfigurationTransfer,
    configurationTransferAgeMs,
} from './lib/configuration-transfer.mjs';
import { isIgnorableProtocolNoise } from './lib/protocol-noise.mjs';
import { setupChatSafeGuard } from './lib/chat-safe.mjs';
import { audit } from '../lib/audit.mjs';

// --- маркеры чата ---
const CLAN_INVITE_OK = '[⚔] Вы отправили приглашение в клан игроку';
const CLAN_JOIN_TAIL = ' присоединился к клану!';
const CLAN_INVEST_LINE = 'пополнил баланс казны';
const CLAN_WITHDRAW_MID = ' снял $';
const CLAN_WITHDRAW_TAIL = ' из казны';
const CLAN_OFFLINE_HEAD = '[⚔] Ошибка: Игрок';
const CLAN_OFFLINE_TAIL = ' не в сети!';
const CLAN_OTHER_CLAN_MARKER = 'состоит в другом клане';
const AFK_MARKER = 'Данная команда недоступна в режиме AFK';
const CAPTCHA_MARKER = 'BotFilter >> Введите номер с картинки в чат';

const LMB = 0;
const SHIFT = 1;
/** Осмотр / сход с AFK в долгих ожиданиях (join, withdraw) */
const AFK_WAIT_MS = 10_000;
const CHAT_POLL_MS = 400;

const config = {
    username: workerData.username,
    password: workerData.password,
    anarchy: workerData.anarchy,
    clanInvestMultiplier: workerData.clanInvestMultiplier ?? 1_000_000,
    clanPhaseTimeoutMs: workerData.clanPhaseTimeoutMs ?? 60_000,
    clanWithdrawSoloTimeoutMs: workerData.clanWithdrawSoloTimeoutMs ?? 300_000,
    clanLoopWaitMs: workerData.clanLoopWaitMs ?? 2000,
    /** пауза после /clan invest до повтора — ждём «пополнил баланс казны» */
    clanInvestWaitMs: workerData.clanInvestWaitMs ?? 15_000,
    clanWithdrawMinRatio: workerData.clanWithdrawMinRatio ?? 0.9,
    clanWithdrawGraceMs: workerData.clanWithdrawGraceMs ?? 60_000,
    clanWithdrawRemainderMs: workerData.clanWithdrawRemainderMs ?? 30_000,
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
    proxy: workerData.proxy,
    afk: false,
    balance: null,
    /** как botMenu в 4narek: что ждём от следующего windowOpen */
    menu: null,
    /** timestamp входа на анархию (scoreboard) */
    timeJoinAnarchy: 0,
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
/** orderId уже успешно выдан — не принимать повторно */
const deliveredOrderIds = new Set();

// флаги выдачи (из чата)
let inviteSent = false;
let playerJoined = false;
let moneyInvested = false;
let playerWithdrew = false;
let playerOffline = false;
let playerInOtherClan = false;
/** сколько должен снять игрок; ждём полную сумму, не первый withdraw */
let expectedWithdrawAmount = 0;
let withdrawnTotal = 0;
/** не кикать / не принимать grace, пока игрок может снять остаток из казны */
let withdrawRemainderUntil = 0;
/** баланс казны клана из чата (Баланс клана:) */
let clanBalance = null;
/** участники из /clan info */
let clanMembersSnapshot = null;

// GUI: слот 11 — и кнопка «участники», и голова игрока в списке
let guiBusy = false;
let permsDone = false;
let kickDone = false;
/** после shift×1 окно прав часто без windowOpen — когда делать shift×2 */
let shift2FallbackAt = 0;

const { logInfo, logOk, logWarn, logServerMessage } = createChatLogger(config.username);
const configTransferLog = { info: logInfo, ok: logOk, warn: logWarn };

process.on('uncaughtException', (err) => {
    if (isIgnorableProtocolNoise(err)) {
        logInfo(`uncaught protocol noise: ${err.message}`);
        return;
    }
    console.error(`[${config.username}] uncaught:`, err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    if (isIgnorableProtocolNoise(reason)) {
        logInfo(`unhandled rejection (noise): ${reason?.message ?? reason}`);
        return;
    }
    console.error(`[${config.username}] unhandled rejection:`, reason);
});

function post(name, extra = {}) {
    parentPort.postMessage({ name, ...extra });
}

function postQueueStatus() {
    post('delivery_queue', {
        active:
            delivering && currentOrder
                ? {
                      orderId: currentOrder.orderId,
                      nick: currentOrder.nick,
                      amount: currentOrder.amount,
                  }
                : null,
        waiting: deliverQueue.map((o) => ({
            orderId: o.orderId,
            nick: o.nick,
            amount: o.amount,
        })),
    });
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

function markAnarchyJoined() {
    if (config.timeJoinAnarchy) return;
    config.timeJoinAnarchy = Date.now();
    logOk(`анархия ${config.anarchy} — вход`);
    logOk(`на анархии an${config.anarchy} → success`);
}

function isOnAnarchyScoreboard(b) {
    for (const sb of Object.values(b?.scoreboards ?? {})) {
        if (JSON.stringify(sb).includes(`${config.anarchy}`)) return true;
    }
    return false;
}

/** Заход на анархию с ожиданием configuration transfer (как 4NAREK, без паузы под АХ). */
async function joinAnarchy(b, { rejoin = false } = {}) {
    const client = b ?? bot;
    if (!client?.chat) return;

    if (rejoin) config.timeJoinAnarchy = 0;

    while (!config.timeJoinAnarchy) {
        if (isInConfigurationTransfer(client)) {
            const ageSec = Math.ceil(configurationTransferAgeMs() / 1000);
            logInfo(`transfer → в configuration ${ageSec}с, жду…`);
            if (configurationTransferAgeMs() > 45_000) {
                logWarn('transfer → configuration timeout 45с');
                throw new Error('configuration transfer timeout');
            }
            await sleep(100);
            continue;
        }
        if (isOnAnarchyScoreboard(client)) {
            markAnarchyJoined();
            break;
        }
        await rnd(1000, 3000);
        logInfo(`${anarchyCmd}… (жду входа)`);
        client.physicsEnabled = false;
        client.chat(anarchyCmd);
        await rnd(3000, 5000);
        if (isOnAnarchyScoreboard(client)) {
            markAnarchyJoined();
            break;
        }
    }

    while (isInConfigurationTransfer(client) && configurationTransferAgeMs() < 45_000) {
        await sleep(100);
    }
    client.physicsEnabled = true;
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

function hasWithdrawGraceEligible(withdrawn, expected) {
    if (expected <= 0) return false;
    const ratio = config.clanWithdrawMinRatio ?? 0.9;
    return withdrawn >= Math.floor(expected * ratio);
}

function resetWithdrawRemainderWait() {
    withdrawRemainderUntil = 0;
}

/** после частичного снятия — дать время добрать копейки из казны */
function bumpWithdrawRemainderWait(reason) {
    const ms = config.clanWithdrawRemainderMs ?? 30_000;
    withdrawRemainderUntil = Date.now() + ms;
    logInfo(`остаток в казне — ждём ${Math.round(ms / 1000)}с (${reason})`);
}

function postWithdrawRemainderHint() {
    if (!currentOrder || expectedWithdrawAmount <= 0) return;
    if (withdrawnTotal >= expectedWithdrawAmount) return;
    post('clan_withdraw_partial', {
        orderId: currentOrder.orderId,
        nick: currentOrder.nick,
        withdrawn: withdrawnTotal,
        full: expectedWithdrawAmount,
    });
}

function logWithdrawGraceWait(phaseDeadline, queued) {
    const remain = expectedWithdrawAmount - withdrawnTotal;
    const secLeft = Math.max(0, Math.round((phaseDeadline - Date.now()) / 1000));
    logInfo(
        `≥${Math.round((config.clanWithdrawMinRatio ?? 0.9) * 100)}% — ждём доснять ${remain} до конца фазы (${secLeft}с${queued ? ', очередь' : ', solo'})`,
    );
    postWithdrawRemainderHint();
}

/** не завершать withdraw раньше конца фазы (60с при очереди / 5мин solo) и мин. 30с на остаток */
function withdrawPhaseEndAt(phaseDeadline, now = Date.now()) {
    if (withdrawRemainderUntil > now) {
        return Math.max(phaseDeadline, withdrawRemainderUntil);
    }
    return phaseDeadline;
}

/** withdraw: solo — 5 мин; при очереди — clanPhaseTimeoutMs (60с). В обоих случаях ≥90% ждём до конца фазы. */
function withdrawPhaseTimeoutMs() {
    const queued = deliverQueue.length > 0;
    if (moneyInvested && !queued) {
        return config.clanWithdrawSoloTimeoutMs;
    }
    return config.clanPhaseTimeoutMs;
}

function resetDeliveryFlags() {
    inviteSent = false;
    playerJoined = false;
    moneyInvested = false;
    playerWithdrew = false;
    playerOffline = false;
    playerInOtherClan = false;
    clanJoinedForCurrent = false;
    expectedWithdrawAmount = 0;
    withdrawnTotal = 0;
    resetWithdrawRemainderWait();
}

function resetGui() {
    config.menu = null;
    guiBusy = false;
    permsDone = false;
    kickDone = false;
    shift2FallbackAt = 0;
}

async function closeWindow() {
    if (!bot?.currentWindow) return;
    try {
        await bot.closeWindow(bot.currentWindow);
    } catch { /* */ }
    await rnd(300, 500);
}

/** Реактивно с AFK-флагом или профилактический осмотр (только без GUI) */
async function afkTick() {
    if (!bot) return;
    if (config.afk) {
        await antiAfkIfNeeded(bot, config, logInfo);
        return;
    }
    if (bot.currentWindow || config.menu != null || guiBusy) return;
    await lookAroundSpin(bot, logInfo);
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

    if (delivering && text.includes(CLAN_OTHER_CLAN_MARKER)) {
        playerInOtherClan = true;
        logInfo(`в другом клане: ${currentOrder?.nick || '?'}`);
        return;
    }

    const bal = parseBalanceFromChat(text);
    if (bal != null) config.balance = bal;

    const clanBal = parseClanBalanceFromChat(text);
    if (clanBal != null) clanBalance = clanBal;

    const members = parseClanMembersFromChat(text);
    if (members != null) clanMembersSnapshot = members;

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
    if (text.includes(CLAN_INVEST_LINE) && nickIn(text, config.username)) {
        moneyInvested = true;
        logOk(`invest: ${config.username}`);
        return;
    }

    // [X] Игрок <ник> снял $... из казны — кикаем только после полной суммы
    if (text.includes('Игрок') && text.includes(CLAN_WITHDRAW_MID) && text.includes(CLAN_WITHDRAW_TAIL) && nickIn(text, nick)) {
        const chunk = parseClanWithdrawAmount(text);
        if (chunk == null) return;
        if (expectedWithdrawAmount <= 0) {
            logInfo(`withdraw +${chunk} (ожидаемая сумма ещё не задана)`);
            return;
        }
        withdrawnTotal += chunk;
        logInfo(`withdraw +${chunk} (${withdrawnTotal}/${expectedWithdrawAmount})`);
        if (withdrawnTotal >= expectedWithdrawAmount) {
            playerWithdrew = true;
            logOk(`withdraw: ${nick}`);
        } else {
            bumpWithdrawRemainderWait(`${withdrawnTotal}/${expectedWithdrawAmount}`);
            postWithdrawRemainderHint();
        }
        return;
    }

    if (text.includes(CLAN_OFFLINE_HEAD) && text.includes(CLAN_OFFLINE_TAIL) && nickIn(text, nick)) {
        playerOffline = true;
        logInfo(`offline: ${nick}`);
    }
}

// ========== GUI (windowOpen) ==========

async function doShift2(slot) {
    if (permsDone || config.menu !== 'clan_shift2' || !bot?.currentWindow) return false;
    shift2FallbackAt = 0;
    logInfo(`shift×2 слот ${slot}`);
    config.menu = null;
    permsDone = true;
    await bot.clickWindow(slot, LMB, SHIFT);
    return true;
}

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
                guiBusy = false; // следующее окно откроется сразу после клика
                await bot.clickWindow(slot, LMB, 0);
                break;

            // окно 2: участники → shift×1 → откроется права
            case 'clan_members':
                await rndClick();
                if (!bot.currentWindow) break;
                logInfo(`shift×1 слот ${slot}`);
                config.menu = 'clan_shift2';
                shift2FallbackAt = Date.now() + 600;
                guiBusy = false; // окно прав откроется само — не блокировать windowOpen
                await bot.clickWindow(slot, LMB, SHIFT);
                break;

            // окно 3: права → shift×2 → готово
            case 'clan_shift2':
                shift2FallbackAt = 0;
                await rndClick();
                if (!bot.currentWindow) break;
                await doShift2(slot);
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
    permsDone = false;
    config.menu = 'clan_menu';
    await closeWindow();
    logInfo('/clan menu');
    bot.chat('/clan menu');
    let lastMenuRetry = Date.now();

    const slot = config.clanMembersMenuSlot;
    while (Date.now() < deadline && !permsDone) {
        await sleep(400);
        // после shift×1 окно прав часто без windowOpen — shift×2 вручную
        if (!permsDone && config.menu === 'clan_shift2' && bot?.currentWindow
            && shift2FallbackAt > 0 && Date.now() >= shift2FallbackAt && !guiBusy) {
            guiBusy = true;
            try {
                await doShift2(slot);
            } finally {
                guiBusy = false;
            }
            continue;
        }
        // после shift×1 окно прав открывается само — не дёргать /clan menu снова
        if (!permsDone && config.menu === 'clan_menu' && !bot?.currentWindow && Date.now() - lastMenuRetry > 12_000) {
            logInfo('права — повтор');
            await closeWindow();
            logInfo('/clan menu');
            bot.chat('/clan menu');
            lastMenuRetry = Date.now();
        } else if (!bot?.currentWindow) {
            await antiAfkIfNeeded(bot, config, logInfo);
        }
    }

    if (permsDone) {
        await rnd(1500, 3500);
        await closeWindow();
        logOk('права withdraw выданы');
        return true;
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

/** После кика — снять всё, что осталось в казне */
async function sweepClanTreasury(waitMs = 15_000) {
    if (!bot?.chat) return 0;
    await closeWindow();
    let bal = await safeClanBalance(waitMs);
    if (bal == null || bal <= 0) {
        if (bal === 0) logInfo('казна пуста');
        return 0;
    }
    const deadline = Date.now() + waitMs;
    let swept = 0;
    while (Date.now() < deadline) {
        logInfo(`казна ${bal} → /clan withdraw ${bal}`);
        clanBalance = null;
        bot.chat(`/clan withdraw ${bal}`);
        await sleep(config.clanLoopWaitMs);
        const after = await safeClanBalance(8000);
        if (after === 0) {
            logOk(`казна собрана: ${bal}`);
            return swept + bal;
        }
        if (after != null && after < bal) {
            swept += bal - after;
            bal = after;
            continue;
        }
        await sleep(2000);
        const recheck = await safeClanBalance(8000);
        if (recheck === 0 || recheck == null) {
            logOk(`казна собрана (~${bal})`);
            return swept + bal;
        }
        bal = recheck;
    }
    logInfo('казна — не удалось собрать полностью');
    return swept;
}

async function kickAndSweepClan(nick, deadline) {
    const kicked = await kickFromClan(nick, deadline);
    await sweepClanTreasury();
    return kicked;
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

async function safeClanBalance(waitMs = 12_000) {
    if (!bot?.chat) return null;
    clanBalance = null;
    const deadline = Date.now() + waitMs;
    let triedBalance = false;
    while (clanBalance == null && Date.now() < deadline) {
        if (!bot) return null;
        await closeWindow();
        bot.chat('/clan money');
        await sleep(config.balanceCmdWaitMs);
        if (clanBalance == null && !triedBalance) {
            triedBalance = true;
            bot.chat('/clan balance');
            await sleep(config.balanceCmdWaitMs);
        }
        if (clanBalance == null) await antiAfkIfNeeded(bot, config, logInfo);
    }
    if (clanBalance != null) logInfo(`баланс клана: ${clanBalance}`);
    return clanBalance;
}

function allowedClanNicks(extraAllow = []) {
    const set = new Set([String(config.username).toLowerCase()]);
    for (const nick of extraAllow) {
        if (nick) set.add(String(nick).toLowerCase());
    }
    return set;
}

async function safeClanInfo(waitMs = 12_000) {
    if (!bot?.chat) return null;
    clanMembersSnapshot = null;
    const deadline = Date.now() + waitMs;
    while (clanMembersSnapshot == null && Date.now() < deadline) {
        if (!bot) return null;
        await closeWindow();
        logInfo('/clan info…');
        bot.chat('/clan info');
        await sleep(config.balanceCmdWaitMs);
        if (clanMembersSnapshot == null) await antiAfkIfNeeded(bot, config, logInfo);
    }
    if (clanMembersSnapshot?.length) {
        logInfo(`clan info: ${clanMembersSnapshot.join(', ')}`);
    }
    return clanMembersSnapshot;
}

/** /clan info → kick всех кроме лидера (+ покупатель, если передан) */
async function purgeIntrudersFromClan(deadline, extraAllow = []) {
    if (!bot?.chat) return;
    const allowed = [...allowedClanNicks(extraAllow)];

    while (Date.now() < deadline) {
        await antiAfkIfNeeded(bot, config, logInfo);
        const waitMs = Math.min(12_000, Math.max(2000, deadline - Date.now()));
        const members = await safeClanInfo(waitMs);
        if (!members?.length) {
            logInfo('clan info — нет строки участников, повтор');
            await sleep(config.clanLoopWaitMs);
            continue;
        }

        const intruders = findClanIntruders(members, allowed);
        if (!intruders.length) {
            logOk(`clan info: чужих нет (${members.length} уч.)`);
            return;
        }

        for (const name of intruders) {
            if (Date.now() >= deadline) return;
            logInfo(`clan: лишний ${name} — kick`);
            await kickFromClan(name, Math.min(deadline, Date.now() + 15_000));
            await sleep(config.clanLoopWaitMs);
            await antiAfkIfNeeded(bot, config, logInfo);
        }
    }
}

// ========== бот ==========

function wireBot(b) {
    setupConfigurationTransferFix(b, configTransferLog);

    b.once('inject_allowed', () => {
        setupChatSafeGuard(b, (text) => {
            logServerMessage(text);
            handleChatMessage(text);
        });
    });

    b.on('windowOpen', () => void onWindowOpen());

    b.on('scoreboardCreated', (scoreboard) => {
        if (JSON.stringify(scoreboard).includes(`${config.anarchy}`)) {
            markAnarchyJoined();
        }
    });

    b.on('spawn', () => {
        b.physicsEnabled = true;
    });

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

    b.on('error', (err) => {
        if (isIgnorableProtocolNoise(err)) {
            logInfo(`protocol noise: ${err.message}`);
            return;
        }
        process.exit(1);
    });

    b._client?.on('error', (err) => {
        if (isIgnorableProtocolNoise(err)) {
            logInfo(`protocol noise: ${err.message}`);
            return;
        }
        process.exit(1);
    });
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
        const botOpts = {
            host: 'mc.funtime.su',
            port: 25565,
            username: config.username,
            password: config.password,
            version: '1.21.11',
            chatLengthLimit: 256,
        };

        try {
            const proxyStr = readBotJsonProxy() || config.proxy;
            const proxy = buildMcProxyConnect(proxyStr);
            if (proxy) {
                botOpts.agent = proxy.agent;
                botOpts.connect = proxy.connect;
                logInfo(`прокси ${maskProxyUrl(proxyStr)}`);
            } else {
                logInfo('прокси: нет — прямое подключение');
            }
        } catch (err) {
            connecting = false;
            reject(err);
            return;
        }

        const b = mineflayer.createBot(botOpts);

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
                logInfo('spawn → /l → joinAnarchy');
                await rnd(1000, 3000);
                b.chat(`/l ${config.password}`);
                config.timeJoinAnarchy = 0;
                await joinAnarchy(b);

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
    const fullInvest = Number(investSum(order.amount));
    const priorWithdrawn = Number(order.priorWithdrawn || 0);
    const investThisRound = Math.max(0, fullInvest - priorWithdrawn);
    const invest = String(investThisRound);
    const orderEnd = Date.now() + config.deliverTimeoutMs;
    const active = () => delivering && currentOrder?.orderId === order.orderId;
    const phaseEnd = () => Date.now() + config.clanPhaseTimeoutMs;

    // 0. баланс
    if (investThisRound > 0) {
        const balance = await safeBalance();
        if (!active()) return;
        if (balance == null || balance < investThisRound) {
            logInfo(`мало денег: ${balance ?? '?'} < ${invest}`);
            endDelivery('insufficient_funds');
            return;
        }
    } else if (priorWithdrawn < fullInvest) {
        logInfo(`invest=0, prior=${priorWithdrawn} < full=${fullInvest}`);
        endDelivery('timeout');
        return;
    }

    // 0.5 клан на двоих — до invite только лидер
    logInfo('clan info — должен быть только лидер…');
    await purgeIntrudersFromClan(phaseEnd());
    if (!active()) return;

    // 1. invite
    logInfo(
        `invite ${nick}, invest ${invest} (полная ${fullInvest}, уже снято ${priorWithdrawn})`,
    );
    resetDeliveryFlags();
    let end = phaseEnd();
    while (active() && Date.now() < orderEnd && Date.now() < end && !inviteSent) {
        if (playerInOtherClan) { endDelivery('player_in_other_clan'); return; }
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
    let lastAfkCheck = 0;
    while (active() && Date.now() < end && !playerJoined) {
        if (playerOffline) { endDelivery('offline'); return; }
        if (Date.now() - lastAfkCheck >= AFK_WAIT_MS) {
            await afkTick();
            lastAfkCheck = Date.now();
        }
        await sleep(CHAT_POLL_MS);
    }
    if (!active()) return;
    if (!playerJoined) {
        await kickAndSweepClan(nick, phaseEnd());
        endDelivery('timeout');
        return;
    }

    // 2.5 после join — лидер + покупатель, все остальные kick
    await purgeIntrudersFromClan(phaseEnd(), [nick]);
    if (!active()) return;

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
        await kickAndSweepClan(nick, phaseEnd());
        endDelivery('timeout');
        return;
    }

    // 4. invest — ждём строку в чате, как invite / withdraw
    config.menu = null;
    guiBusy = false;
    await closeWindow();
    await rnd(500, 1000);
    moneyInvested = investThisRound <= 0;
    if (investThisRound > 0) {
        logInfo(`invest ${invest}`);
        end = phaseEnd();
        lastAfkCheck = 0;
        while (active() && Date.now() < end && !moneyInvested) {
            if (Date.now() - lastAfkCheck >= AFK_WAIT_MS) {
                await afkTick();
                lastAfkCheck = Date.now();
            }
            if (config.afk) {
                await antiAfkIfNeeded(bot, config, logInfo);
                await sleep(CHAT_POLL_MS);
                continue;
            }
            await closeWindow();
            logInfo(`/clan invest ${invest}`);
            bot.chat(`/clan invest ${invest}`);
            const attemptEnd = Date.now() + config.clanInvestWaitMs;
            while (Date.now() < attemptEnd && !moneyInvested) {
                if (Date.now() - lastAfkCheck >= AFK_WAIT_MS) {
                    await afkTick();
                    lastAfkCheck = Date.now();
                }
                await sleep(CHAT_POLL_MS);
            }
        }
        if (!active()) return;
        if (!moneyInvested) {
            await kickAndSweepClan(nick, phaseEnd());
            endDelivery('timeout');
            return;
        }
        post('clan_invested', {
            orderId: order.orderId,
            nick,
            investAmount: invest,
            withdrawAmount: invest,
            fullInvestAmount: String(fullInvest),
            amountKk: order.amount,
            priorWithdrawn,
        });
    } else {
        logInfo('invest пропуск — игрок уже снял полную сумму');
    }

    // 5. withdraw — полная сумма; ≥90% ждём до конца фазы; после частичного — мин. 30с на остаток
    expectedWithdrawAmount = fullInvest;
    withdrawnTotal = priorWithdrawn;
    playerWithdrew = priorWithdrawn >= fullInvest;
    resetWithdrawRemainderWait();
    if (priorWithdrawn > 0 && priorWithdrawn < fullInvest) {
        bumpWithdrawRemainderWait(`уже снято ${priorWithdrawn}/${fullInvest}`);
    }
    const withdrawQueued = deliverQueue.length > 0;
    const withdrawMs = withdrawPhaseTimeoutMs();
    logInfo(
        `ждём withdraw ${nick} (${withdrawnTotal}/${expectedWithdrawAmount}), таймаут ${Math.round(withdrawMs / 1000)}с` +
            (withdrawQueued ? ' (очередь — до конца фазы)' : ' (solo — до конца фазы)'),
    );
    const phaseDeadline = Date.now() + withdrawMs;
    let gracePhaseNotified = false;
    if (hasWithdrawGraceEligible(withdrawnTotal, expectedWithdrawAmount)) {
        gracePhaseNotified = true;
        logWithdrawGraceWait(phaseDeadline, withdrawQueued);
    }
    lastAfkCheck = 0;
    while (active() && !playerWithdrew) {
        const now = Date.now();
        if (now >= orderEnd) {
            logInfo('withdraw — общий лимит выдачи');
            break;
        }
        if (playerOffline) {
            endDelivery('offline');
            return;
        }
        if (withdrawnTotal >= expectedWithdrawAmount) {
            playerWithdrew = true;
            logOk(`withdraw: ${nick}`);
            break;
        }
        const graceEligible = hasWithdrawGraceEligible(withdrawnTotal, expectedWithdrawAmount);
        if (graceEligible && !gracePhaseNotified) {
            gracePhaseNotified = true;
            logWithdrawGraceWait(phaseDeadline, withdrawQueued);
        }
        if (now >= withdrawPhaseEndAt(phaseDeadline, now)) {
            if (graceEligible) {
                playerWithdrew = true;
                logOk(
                    `withdraw ≥${Math.round((config.clanWithdrawMinRatio ?? 0.9) * 100)}% (конец фазы${withdrawQueued ? ', очередь' : ''}): ${nick}`,
                );
            }
            break;
        }
        if (Date.now() - lastAfkCheck >= AFK_WAIT_MS) {
            await afkTick();
            lastAfkCheck = Date.now();
        }
        await sleep(CHAT_POLL_MS);
    }
    if (!active()) return;
    if (!playerWithdrew) {
        await kickAndSweepClan(nick, phaseEnd());
        endDelivery('timeout', deliverQueue.length);
        return;
    }

    // 6. kick + собрать остаток казны
    await kickAndSweepClan(nick, phaseEnd());
    if (!active()) return;
    endDelivery('ok');
}

const FATAL = new Set(['banned', 'captcha']);

function endDelivery(result, queued) {
    if (!currentOrder) return;
    const { orderId, nick, amount: amountKk } = currentOrder;
    const q = queued ?? deliverQueue.length;
    const totalWithdrawn = Math.max(withdrawnTotal, Number(currentOrder.priorWithdrawn || 0));
    const playerWithdrawn = totalWithdrawn > 0 ? totalWithdrawn : undefined;
    delivering = false;
    currentOrder = null;
    resetDeliveryFlags();
    resetGui();

    postQueueStatus();

    if (result === 'ok') {
        deliveredOrderIds.add(orderId);
        void audit('game_clan_ok', { orderId, nick, amountKk });
        post('delivery_ok', { orderId });
    } else if (result === 'offline') {
        post('player_offline', { orderId });
    } else if (result === 'player_in_other_clan') {
        post('player_in_other_clan', { orderId, nick });
    } else if (result === 'insufficient_funds') {
        post('insufficient_funds', { orderId });
    } else if (result === 'banned') {
        post('delivery_failed', { orderId, reason: 'banned' });
    } else if (result === 'captcha') {
        post('delivery_failed', { orderId, reason: 'captcha' });
    } else if (result === 'timeout' && q > 0) {
        post('delivery_stalled', {
            orderId,
            reason: 'clan_withdraw_timeout',
            queued: q,
            playerWithdrawn,
        });
    } else if (result === 'timeout') {
        post('delivery_stalled', {
            orderId,
            reason: 'clan_timeout',
            queued: q,
            playerWithdrawn,
        });
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
    postQueueStatus();
    logInfo(`выдача ${order.orderId.slice(0, 8)}… ${order.nick} ${order.amount}kk`);

    try {
        await closeWindow();
        await antiAfkIfNeeded(bot, config, logInfo);
        config.timeJoinAnarchy = 0;
        await joinAnarchy(bot, { rejoin: true });

        await deliverClan();
    } catch (e) {
        logInfo(`crash: ${e.message}`);
        await kickAndSweepClan(order.nick, Date.now() + config.clanPhaseTimeoutMs);
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
    if (deliveredOrderIds.has(order.orderId)) {
        logInfo(`пропуск — заказ ${order.orderId.slice(0, 8)}… уже выдан`);
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
    postQueueStatus();

    clearTimeout(idleQuitTimer);
    try {
        await connectBot();
        nextOrder();
    } catch (e) {
        post('connect_failed', { reason: e.message });
    }
}

function cancelOrder(orderId) {
    if (currentOrder?.orderId === orderId && moneyInvested) {
        logInfo(`отмена отклонена: деньги уже в казне (${orderId.slice(0, 8)}…)`);
        return;
    }
    for (let i = deliverQueue.length - 1; i >= 0; i--) {
        if (deliverQueue[i].orderId === orderId) deliverQueue.splice(i, 1);
    }
    if (currentOrder?.orderId !== orderId) {
        postQueueStatus();
        return;
    }
    const nick = currentOrder.nick;
    void kickAndSweepClan(nick, Date.now() + config.clanPhaseTimeoutMs).finally(() => {
        delivering = false;
        currentOrder = null;
        resetDeliveryFlags();
        postQueueStatus();
        nextOrder();
    });
}

// ========== старт ==========

logInfo('воркер (клан)');

async function warmupOnStart() {
    await sleep(2000);
    if (delivering || currentOrder || deliverQueue.length || healthCheckActive) return;
    try {
        logInfo('авто-подключение…');
        await connectBot();
    } catch (err) {
        logInfo(`авто-подключение: ${err.message}`);
        process.exit(1);
    }
}

void warmupOnStart();

parentPort.on('message', (data) => {
    if (data?.type === 'health_check') void runHealthCheck();
    if (data?.type === 'deliver' && data.order) void addOrder(data.order);
    if (data?.type === 'cancel_order' && data.orderId) cancelOrder(data.orderId);
    if (data?.type === 'stop') { shutdown('stop'); process.exit(0); }
});
