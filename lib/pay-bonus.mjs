/**
 * Выплата = лот + случайное колесо (5/8/12/15% к лоту) + при повторе в 24ч ещё +5% к лоту.
 * Не «дневное накопление»: на каждый заказ одно колесо; +5% только если прошлая выдача была <24ч назад.
 */

/** Доли колеса (сумма = 100): +5 / +8 / +12 / +15 % */
export const WHEEL_TIERS = [
    { pct: 5, weight: 45 },
    { pct: 8, weight: 40 },
    { pct: 12, weight: 12 },
    { pct: 15, weight: 3 },
];

/** Доп. % к лоту, если покупатель уже получал выдачу за последние 24ч */
export const REPEAT_EXTRA_PCT = 5;

export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Сообщение про повторную покупку — через столько мс после PlayerOK SENT */
export const REPEAT_PROMO_DELAY_MS = 10_000;

export function rollWheelBonusPct() {
    const total = WHEEL_TIERS.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * total;
    for (const tier of WHEEL_TIERS) {
        r -= tier.weight;
        if (r <= 0) return tier.pct;
    }
    return WHEEL_TIERS[WHEEL_TIERS.length - 1].pct;
}

export function buyerEligibleForRepeatBonus(state, buyerId) {
    if (!buyerId || !state?.buyerBonus) return false;
    const rec = state.buyerBonus[buyerId];
    if (!rec?.at) return false;
    return Date.now() - Date.parse(rec.at) < REPEAT_WINDOW_MS;
}

export function recordBuyerDelivery(state, buyerId) {
    if (!buyerId) return;
    if (!state.buyerBonus) state.buyerBonus = {};
    state.buyerBonus[buyerId] = { at: new Date().toISOString() };
}

/**
 * @returns {{ lotKk: number, wheelPct: number, repeatPct: number, totalPct: number, payAmountKk: number }}
 */
export function computeOrderPayout(lotKk, { wheelPct, repeatPct }) {
    const lot = Number(lotKk);
    const wheel = Number(wheelPct) || 0;
    const repeat = Number(repeatPct) || 0;
    const wheelKk = wheel > 0 ? Math.round((lot * wheel) / 100) : 0;
    const repeatKk = repeat > 0 ? Math.round((lot * repeat) / 100) : 0;
    const totalPct = wheel + repeat;
    const payAmountKk = Math.max(1, lot + wheelKk + repeatKk);
    return {
        lotKk: lot,
        wheelPct: wheel,
        repeatPct: repeat,
        bonusWheelKk: wheelKk,
        bonusRepeatKk: repeatKk,
        totalPct,
        payAmountKk,
    };
}

/** Зафиксировать бонус на заказе (один раз до выдачи). */
export function applyOrderPayBonus(state, order) {
    if (!order?.orderId && !order?.dealId) return null;
    const id = order.orderId || order.dealId;
    const existing = state.orders[id];
    if (existing?.bonusComputedAt && existing.payAmountKk != null) {
        return existing;
    }

    const lotKk = Number(order.amountKk ?? existing?.amountKk);
    if (!lotKk || lotKk <= 0) return existing || order;

    const wheelPct = rollWheelBonusPct();
    const repeatPct = buyerEligibleForRepeatBonus(state, order.buyerId ?? existing?.buyerId)
        ? REPEAT_EXTRA_PCT
        : 0;
    const payout = computeOrderPayout(lotKk, { wheelPct, repeatPct });

    const short = String(id).slice(0, 8);
    const repeatNote = repeatPct > 0 ? `, повтор +${repeatPct}%` : '';
    console.log(
        `[sell] бонус ${short}…: лот ${lotKk}kk, колесо +${wheelPct}%${repeatNote} → выплата ${payout.payAmountKk}kk`,
    );

    const patch = {
        amountKk: payout.lotKk,
        bonusWheelPct: payout.wheelPct,
        bonusRepeatPct: payout.repeatPct,
        bonusWheelKk: payout.bonusWheelKk,
        bonusRepeatKk: payout.bonusRepeatKk,
        bonusTotalPct: payout.totalPct,
        payAmountKk: payout.payAmountKk,
        bonusComputedAt: new Date().toISOString(),
    };

    if (state.orders[id]) {
        Object.assign(state.orders[id], patch);
        return state.orders[id];
    }
    return { ...order, ...patch };
}
