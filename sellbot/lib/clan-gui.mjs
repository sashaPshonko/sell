import {
    closeWindowSafe,
    findNickSlot,
    rndClickDelay,
    safeClanChatLoop,
} from './clan-delivery.mjs';

export const CLAN_WINDOW = {
    CLAN_MENU: 'clan_menu',
    CLAN_MEMBERS: 'clan_members',
    CLAN_PERMS: 'clan_perms',
    CLAN_KICK_CONFIRM: 'clan_kick_confirm',
};

const LEFT_MOUSE = 0;
const SHIFT_CLICK = 1;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export function createClanGuiState() {
    return {
        expectMenu: null,
        windowKey: 0,
        flow: null,
    };
}

/** Перед chat-командой или кликом, который откроет окно */
export function setExpectMenu(guiState, menu) {
    guiState.expectMenu = menu;
}

function clearFlow(guiState) {
    guiState.flow = null;
}

function finishFlow(guiState, ok, reason = null) {
    if (!guiState.flow) return;
    guiState.flow.done = true;
    guiState.flow.ok = ok;
    guiState.flow.reason = reason;
}

/**
 * windowOpen — единственное место кликов.
 * expectMenu задаётся перед chat/кликом и не сбрасывается.
 */
export async function handleClanWindowOpen(bot, guiState, config, log) {
    if (!bot?.currentWindow) return;

    const flow = guiState.flow;
    if (!flow || flow.done) return;

    const expected = guiState.expectMenu;
    if (!expected) return;

    const key = ++guiState.windowKey;
    log(`windowOpen → ${expected} (key …${String(key).slice(-4)})`);

    const stale = () => key !== guiState.windowKey;

    try {
        switch (expected) {
            case CLAN_WINDOW.CLAN_MENU:
                if (flow.kind !== 'grant' || flow.step !== 'need_menu') return;

                await rndClickDelay(config);
                if (stale() || !bot.currentWindow) return;

                const membersSlot = Number(config.clanMembersMenuSlot) || 11;
                setExpectMenu(guiState, CLAN_WINDOW.CLAN_MEMBERS);
                log(`clan_menu → клик слот ${membersSlot}`);
                await bot.clickWindow(membersSlot, LEFT_MOUSE, 0);
                flow.step = 'need_members_list';
                break;

            case CLAN_WINDOW.CLAN_MEMBERS:
                if (flow.kind !== 'grant') return;

                if (flow.step === 'need_members_list') {
                    await rndClickDelay(config);
                    if (stale() || !bot.currentWindow) return;

                    const slot = findNickSlot(bot.currentWindow, flow.nick);
                    if (slot < 0) {
                        log(`clan_members: ник ${flow.nick} не найден`);
                        finishFlow(guiState, false, 'nick_not_found');
                        await closeWindowSafe(bot);
                        return;
                    }

                    flow.nickSlot = slot;
                    setExpectMenu(guiState, CLAN_WINDOW.CLAN_PERMS);
                    log(`clan_members: ${flow.nick} → слот ${slot}, shift×1`);
                    await bot.clickWindow(slot, LEFT_MOUSE, SHIFT_CLICK);
                    flow.step = 'need_second_shift';
                    break;
                }

                if (flow.step === 'need_second_shift' && flow.nickSlot >= 0) {
                    await rndClickDelay(config);
                    if (stale() || !bot.currentWindow) return;
                    log(`clan_members: слот ${flow.nickSlot}, shift×2`);
                    await bot.clickWindow(flow.nickSlot, LEFT_MOUSE, SHIFT_CLICK);
                    await closeWindowSafe(bot);
                    finishFlow(guiState, true);
                }
                break;

            case CLAN_WINDOW.CLAN_PERMS:
                if (flow.kind !== 'grant' || flow.step !== 'need_second_shift') return;
                if (flow.nickSlot < 0) return;

                await rndClickDelay(config);
                if (stale() || !bot.currentWindow) return;
                log(`clan_perms: слот ${flow.nickSlot}, shift×2`);
                await bot.clickWindow(flow.nickSlot, LEFT_MOUSE, SHIFT_CLICK);
                await closeWindowSafe(bot);
                finishFlow(guiState, true);
                break;

            case CLAN_WINDOW.CLAN_KICK_CONFIRM:
                if (flow.kind !== 'kick' || flow.step !== 'need_confirm') return;

                await rndClickDelay(config);
                if (stale() || !bot.currentWindow) return;

                const confirmSlot = Number(config.clanKickConfirmSlot) || 0;
                log(`clan_kick_confirm → слот ${confirmSlot}`);
                await bot.clickWindow(confirmSlot, LEFT_MOUSE, 0);
                await sleep(800);
                await closeWindowSafe(bot);
                finishFlow(guiState, true);
                break;

            default:
                log(`windowOpen: неизвестное expectMenu «${expected}»`);
                break;
        }
    } catch (e) {
        log(`windowOpen ошибка: ${e.message}`);
        finishFlow(guiState, false, e.message);
    }
}

export function attachClanGuiHandler(bot, guiState, config, log) {
    if (bot.__clanGuiAttached) return;
    bot.__clanGuiAttached = true;
    bot.on('windowOpen', () => {
        void handleClanWindowOpen(bot, guiState, config, log);
    });
}

export async function runGrantWithdrawPerms(bot, botState, guiState, config, log, nick, deadline) {
    clearFlow(guiState);

    guiState.flow = {
        kind: 'grant',
        nick,
        step: 'need_menu',
        nickSlot: -1,
        done: false,
        ok: false,
        reason: null,
    };

    while (Date.now() < deadline && guiState.flow && !guiState.flow.done) {
        if (guiState.flow.step === 'need_menu') {
            await safeClanChatLoop(bot, botState, log, '/clan menu', {
                onBeforeChat: () => setExpectMenu(guiState, CLAN_WINDOW.CLAN_MENU),
                untilOk: () =>
                    guiState.flow?.done ||
                    guiState.flow?.step !== 'need_menu',
                deadline: Math.min(deadline, Date.now() + 10_000),
                loopWaitMs: config.clanLoopWaitMs ?? 2000,
            });
        }
        await sleep(200);
    }

    const ok = Boolean(guiState.flow?.ok);
    clearFlow(guiState);
    return ok;
}

export async function runKickFromClan(bot, botState, guiState, config, log, nick, deadline) {
    clearFlow(guiState);

    guiState.flow = {
        kind: 'kick',
        nick,
        step: 'need_confirm',
        nickSlot: -1,
        done: false,
        ok: false,
        reason: null,
    };

    const cmd = `/clan kick ${nick}`;

    while (Date.now() < deadline && guiState.flow && !guiState.flow.done) {
        if (guiState.flow.step === 'need_confirm') {
            await safeClanChatLoop(bot, botState, log, cmd, {
                onBeforeChat: () => setExpectMenu(guiState, CLAN_WINDOW.CLAN_KICK_CONFIRM),
                untilOk: () =>
                    guiState.flow?.done ||
                    guiState.flow?.step !== 'need_confirm',
                deadline: Math.min(deadline, Date.now() + 10_000),
                loopWaitMs: config.clanLoopWaitMs ?? 2000,
            });
        }
        await sleep(200);
    }

    const ok = Boolean(guiState.flow?.ok);
    clearFlow(guiState);
    return ok;
}

export function resetClanGuiState(guiState) {
    if (!guiState) return;
    clearFlow(guiState);
}
