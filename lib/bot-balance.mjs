/** Кэш баланса MC-бота выдачи (пишет poll из событий sellbot). */

import {
    BONUS_MAX_KK,
    WHEEL_TIERS,
    wheelBonusKkFromPct,
} from './pay-bonus.mjs';

export const KK_TO_COINS = 1_000_000;

/** Кэш старше этого — не блокируем выдачу (мог устареть после park / reconnect). */
const BALANCE_FRESH_MS = 5 * 60_000;

const MAX_WHEEL_PCT = Math.max(...WHEEL_TIERS.map((t) => t.pct));

export function orderNeedCoins(order) {
    const kk = Number(order?.payAmountKk ?? order?.amountKk) || 0;
    return Math.round(kk * KK_TO_COINS);
}

export function getBotBalanceCoins(state) {
    const n = Number(state?.botBalance?.coins);
    return Number.isFinite(n) ? n : null;
}

export function coinsToKkFloor(coins) {
    const n = Number(coins);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n / KK_TO_COINS);
}

/**
 * Макс. лот в кк, который бот потянет с учётом худшего бонуса колеса (cap BONUS_MAX_KK).
 * payAmount = lot + bonus ≤ balanceKk.
 */
export function maxAffordableLotKk(balanceCoins) {
    const balKk = coinsToKkFloor(balanceCoins);
    if (balKk <= 0) return 0;
    let lo = 0;
    let hi = balKk;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const need = mid + wheelBonusKkFromPct(mid, MAX_WHEEL_PCT);
        if (need <= balKk) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/** Контекст для подсказки покупателю при нехватке валюты. */
export function insufficientFundsHintCtx(state, order, balanceCoinsOverride = null) {
    const coins =
        balanceCoinsOverride != null && Number.isFinite(Number(balanceCoinsOverride))
            ? Number(balanceCoinsOverride)
            : getBotBalanceCoins(state);
    const needLotKk = Math.round(Number(order?.amountKk) || 0);
    const needPayKk = Math.round(Number(order?.payAmountKk ?? order?.amountKk) || 0);
    const balanceKk = coins != null ? coinsToKkFloor(coins) : null;
    const availableLotKk =
        coins != null ? maxAffordableLotKk(coins) : null;
    return {
        needLotKk,
        needPayKk,
        balanceKk,
        availableLotKk,
        /** бонус уже заложен в availableLotKk через max wheel */
        bonusReserveKk: BONUS_MAX_KK,
    };
}

function balanceIsFresh(state) {
    const at = Date.parse(state?.botBalance?.updatedAt || 0);
    if (!Number.isFinite(at) || at <= 0) return false;
    return Date.now() - at <= BALANCE_FRESH_MS;
}

/** true = хватает или баланса ещё нет/протух (пусть sellbot сам проверит). */
export function canAffordOrder(state, order) {
    const bal = getBotBalanceCoins(state);
    if (bal == null) return true;
    if (!balanceIsFresh(state)) return true;
    return bal >= orderNeedCoins(order);
}

/** Сброс кэша — пока null, canAffordOrder не блокирует (ждём /balance). */
export function clearBotBalance(state) {
    if (!state) return null;
    state.botBalance = null;
    return null;
}

export function setBotBalance(state, coins, meta = {}) {
    if (!state) return null;
    if (coins == null || coins === '') return clearBotBalance(state);
    const n = Number(coins);
    if (!Number.isFinite(n)) return state.botBalance || null;
    state.botBalance = {
        coins: Math.max(0, Math.round(n)),
        updatedAt: new Date().toISOString(),
        username: meta.username || state.botBalance?.username || null,
    };
    return state.botBalance;
}
