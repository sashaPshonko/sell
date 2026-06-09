import { antiAfkIfNeeded } from './afk-look.mjs';

/** Полная подстрока — invite отправлен */
export const CLAN_INVITE_SENT_MARKER = '[⚔] Вы отправили приглашение в клан игроку';

export const CLAN_JOINED_SUFFIX = ' присоединился к клану!';
export const CLAN_WITHDRAW_MARKER = ' снял $';
export const CLAN_WITHDRAW_SUFFIX = ' из казны клана!';

export const CLAN_OFFLINE_PREFIX = '[⚔] Ошибка: Игрок';
export const CLAN_OFFLINE_SUFFIX = ' не в сети!';

export function stripMcFormatting(text) {
    return String(text)
        .replace(/§./g, '')
        .replace(/&[0-9a-fk-or]/gi, '');
}

export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function nickInMessage(text, nick) {
    return new RegExp(`\\b${escapeRegex(nick)}\\b`, 'i').test(text);
}

export function formatClanInvestAmount(amountKk, multiplier = 1_000_000) {
    return String(Math.round(Number(amountKk) * Number(multiplier)));
}

export function formatClanWithdrawHintAmount(amountKk, multiplier = 1_000_000) {
    const n = Math.round(Number(amountKk) * Number(multiplier));
    return n.toLocaleString('en-US');
}

export function isClanInviteSentLine(text) {
    return stripMcFormatting(text).includes(CLAN_INVITE_SENT_MARKER);
}

export function isClanJoinedLine(text, nick) {
    const plain = stripMcFormatting(text);
    if (!plain.includes('[⚔] Игрок') || !plain.includes(CLAN_JOINED_SUFFIX)) return false;
    return nickInMessage(plain, nick);
}

export function isClanWithdrawLine(text, nick) {
    const plain = stripMcFormatting(text);
    if (!plain.includes('[⚔] Игрок') || !plain.includes(CLAN_WITHDRAW_MARKER)) return false;
    if (!plain.includes(CLAN_WITHDRAW_SUFFIX)) return false;
    return nickInMessage(plain, nick);
}

export function isClanPlayerOfflineLine(text, nick) {
    const plain = stripMcFormatting(text);
    if (!plain.includes(CLAN_OFFLINE_PREFIX) || !plain.includes(CLAN_OFFLINE_SUFFIX)) {
        return false;
    }
    return nickInMessage(plain, nick);
}

export function slotContainsNick(slot, nick) {
    if (!slot || !nick) return false;
    try {
        return JSON.stringify(slot).toLowerCase().includes(String(nick).toLowerCase());
    } catch {
        return false;
    }
}

export function findNickSlot(window, nick) {
    if (!window?.slots) return -1;
    for (let i = 0; i < window.slots.length; i++) {
        if (slotContainsNick(window.slots[i], nick)) return i;
    }
    return -1;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export function rndClickDelay(config) {
    const min = Number(config.clanClickDelayMinMs) || 1500;
    const max = Number(config.clanClickDelayMaxMs) || 4500;
    const ms = min + Math.floor(Math.random() * (max - min + 1));
    return sleep(ms);
}

export async function closeWindowSafe(bot) {
    if (!bot?.currentWindow) return;
    try {
        await bot.closeWindow(bot.currentWindow);
    } catch {
        /* ignore */
    }
    await sleep(300 + Math.floor(Math.random() * 200));
}

/**
 * Цикл chat-команды с anti-AFK (как safeAH).
 * @returns {Promise<'ok'|'offline'|'timeout'>}
 */
export async function safeClanChatLoop(bot, botState, log, cmd, {
    untilOk,
    untilOffline,
    deadline,
    loopWaitMs = 2000,
}) {
    let attempt = 0;
    while (Date.now() < deadline) {
        attempt += 1;
        if (untilOk?.()) return 'ok';
        if (untilOffline?.()) return 'offline';

        await antiAfkIfNeeded(bot, botState, log);
        if (botState.afk) {
            await sleep(loopWaitMs);
            continue;
        }

        if (!bot?.chat) return 'timeout';

        await closeWindowSafe(bot);
        log(`clan cmd #${attempt}: ${cmd}`);
        try {
            bot.chat(cmd);
        } catch (e) {
            log(`chat fail: ${e.message}`);
            return 'timeout';
        }
        await sleep(loopWaitMs);

        if (untilOk?.()) return 'ok';
        if (untilOffline?.()) return 'offline';
    }
    return untilOk?.() ? 'ok' : 'timeout';
}
