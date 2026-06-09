import {
    closeWindowSafe,
    findNickSlot,
    rndClickDelay,
    safeClanChatLoop,
} from './clan-delivery.mjs';

/** Название окна — задаётся вручную перед действием, которое его откроет */
export const CLAN_WINDOW = {
    NONE: '',
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
        /** Текущее открытое окно (из expectMenu в windowOpen) */
        menu: CLAN_WINDOW.NONE,
        /** Какое окно ждём от следующего windowOpen */
        expectMenu: CLAN_WINDOW.NONE,
        windowKey: 0,
        flow: null,
    };
}

/** Перед /clan menu, кликом и т.д. — как config.menu = … перед safeClickBuy в 4NAREK */
export function expectClanWindow(guiState, menu) {
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
 * menu берётся из expectMenu (установлено до команды/клика).
 */
export async function handleClanWindowOpen(bot, guiState, config, log) {
    if (!bot?.currentWindow) return;

    const key = ++guiState.windowKey;

    const expected = guiState.expectMenu;
    if (!expected || expected === CLAN_WINDOW.NONE) {
        log('windowOpen: expectMenu не задан — игнор');
        return;
    }

    guiState.menu = expected;
    guiState.expectMenu = CLAN_WINDOW.NONE;
    log(`windowOpen → ${guiState.menu} (key …${String(key).slice(-4)})`);

    const flow = guiState.flow;
    if (!flow || flow.done) return;

    const stale = () => key !== guiState.windowKey;

    try {
        switch (guiState.menu) {
            case CLAN_WINDOW.CLAN_MENU:
                if (flow.kind !== 'grant' || flow.step !== 'need_menu') break;

                await rndClickDelay(config);
                if (stale() || !bot.currentWindow) return;

                const membersSlot = Number(config.clanMembersMenuSlot) || 11;
                expectClanWindow(guiState, CLAN_WINDOW.CLAN_MEMBERS);
                log(`clan_menu → клик слот ${membersSlot}`);
                await bot.clickWindow(membersSlot, LEFT_MOUSE, 0);
                flow.step = 'need_members_list';
                break;

            case CLAN_WINDOW.CLAN_MEMBERS:
                if (flow.kind !== 'grant') break;

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
                    expectClanWindow(guiState, CLAN_WINDOW.CLAN_PERMS);
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
                if (flow.kind !== 'grant' || flow.step !== 'need_second_shift') break;
                if (flow.nickSlot < 0) break;

                await rndClickDelay(config);
                if (stale() || !bot.currentWindow) return;
                log(`clan_perms: слот ${flow.nickSlot}, shift×2`);
                await bot.clickWindow(flow.nickSlot, LEFT_MOUSE, SHIFT_CLICK);
                await closeWindowSafe(bot);
                finishFlow(guiState, true);
                break;

            case CLAN_WINDOW.CLAN_KICK_CONFIRM:
                if (flow.kind !== 'kick' || flow.step !== 'need_confirm') break;

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
                log(`windowOpen: неизвестное menu «${guiState.menu}»`);
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

/**
 * grant: снаружи /clan menu; клики — только в windowOpen.
 */
export async function runGrantWithdrawPerms(bot, botState, guiState, config, log, nick, deadline) {
    clearFlow(guiState);
    guiState.expectMenu = CLAN_WINDOW.NONE;
    guiState.menu = CLAN_WINDOW.NONE;

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
            expectClanWindow(guiState, CLAN_WINDOW.CLAN_MENU);
            await safeClanChatLoop(bot, botState, log, '/clan menu', {
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
    guiState.expectMenu = CLAN_WINDOW.NONE;
    guiState.menu = CLAN_WINDOW.NONE;
    return ok;
}

export async function runKickFromClan(bot, botState, guiState, config, log, nick, deadline) {
    clearFlow(guiState);
    guiState.expectMenu = CLAN_WINDOW.NONE;
    guiState.menu = CLAN_WINDOW.NONE;

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
            expectClanWindow(guiState, CLAN_WINDOW.CLAN_KICK_CONFIRM);
            await safeClanChatLoop(bot, botState, log, cmd, {
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
    guiState.expectMenu = CLAN_WINDOW.NONE;
    guiState.menu = CLAN_WINDOW.NONE;
    return ok;
}

export function resetClanGuiState(guiState) {
    if (!guiState) return;
    guiState.menu = CLAN_WINDOW.NONE;
    guiState.expectMenu = CLAN_WINDOW.NONE;
    clearFlow(guiState);
}
