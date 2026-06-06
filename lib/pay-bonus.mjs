/**
 * Выплата = лот + случайное колесо + при повторе в 24ч ещё +5% к лоту.
 * На крупных лотах (>= WHEEL_HIGH_LOT_KK) — отдельная, более низкая шкала.
 */

/** Обычные лоты: +3 / +5 / +7 / +9 % */
export const WHEEL_TIERS = [
    { pct: 3, weight: 45 },
    { pct: 5, weight: 40 },
    { pct: 7, weight: 12 },
    { pct: 9, weight: 3 },
];

/** Лот >= WHEEL_HIGH_LOT_KK: +1 / +2 / +3 / +5 % */
export const WHEEL_TIERS_HIGH_LOT = [
    { pct: 1, weight: 45 },
    { pct: 2, weight: 40 },
    { pct: 3, weight: 12 },
    { pct: 5, weight: 3 },
];

/** С какого лота (kk) брать WHEEL_TIERS_HIGH_LOT. Env: WHEEL_HIGH_LOT_KK */
export const WHEEL_HIGH_LOT_KK = Number(process.env.WHEEL_HIGH_LOT_KK) || 100;

/** Доп. % к лоту, если покупатель уже получал выдачу за последние 24ч */
export const REPEAT_EXTRA_PCT = 5;

export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Сообщение про повторную покупку — через столько мс после PlayerOK SENT */
export const REPEAT_PROMO_DELAY_MS = 10_000;

/** Профильный upsell — через столько мс после repeat_promo */
export const PROFILE_UPSELL_DELAY_AFTER_PROMO_MS = 8000;

export function wheelTiersForLot(lotKk) {
    const lot = Number(lotKk) || 0;
    return lot >= WHEEL_HIGH_LOT_KK ? WHEEL_TIERS_HIGH_LOT : WHEEL_TIERS;
}

/** Текст для приветствия: «+3%, +5%, …» */
export function formatWheelBonusTiersText(lotKk) {
    const tiers = wheelTiersForLot(lotKk);
    return tiers.map((t) => `+${t.pct}%`).join(', ');
}

export function rollWheelBonusPct(lotKk = 0) {
    const tiers = wheelTiersForLot(lotKk);
    const total = tiers.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * total;
    for (const tier of tiers) {
        r -= tier.weight;
        if (r <= 0) return tier.pct;
    }
    return tiers[tiers.length - 1].pct;
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

    const wheelPct = rollWheelBonusPct(lotKk);
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
