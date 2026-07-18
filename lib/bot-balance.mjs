/** Кэш баланса MC-бота выдачи (пишет poll из событий sellbot). */

export const KK_TO_COINS = 1_000_000;

export function orderNeedCoins(order) {
    const kk = Number(order?.payAmountKk ?? order?.amountKk) || 0;
    return Math.round(kk * KK_TO_COINS);
}

export function getBotBalanceCoins(state) {
    const n = Number(state?.botBalance?.coins);
    return Number.isFinite(n) ? n : null;
}

/** true = хватает или баланса ещё нет (пусть sellbot сам проверит). */
export function canAffordOrder(state, order) {
    const bal = getBotBalanceCoins(state);
    if (bal == null) return true;
    return bal >= orderNeedCoins(order);
}

export function setBotBalance(state, coins, meta = {}) {
    if (!state) return null;
    const n = Number(coins);
    if (!Number.isFinite(n)) return state.botBalance || null;
    state.botBalance = {
        coins: Math.max(0, Math.round(n)),
        updatedAt: new Date().toISOString(),
        username: meta.username || state.botBalance?.username || null,
    };
    return state.botBalance;
}
