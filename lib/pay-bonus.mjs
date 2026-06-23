/**
 * Выплата = лот + случайный % (с потолком в кк) + при повторе в 24ч +5% к лоту.
 * Покупателю % случайного бонуса не показываем — только кк в выдаче.
 */

/** Макс. случайный бонус в кк (10_000_000 raw при multiplier 1M) */
export const BONUS_MAX_KK = 10;

/** Случайный бонус: +5 / +7 / +10 / +12 % */
export const WHEEL_TIERS = [
    { pct: 5, weight: 45 },
    { pct: 7, weight: 40 },
    { pct: 10, weight: 12 },
    { pct: 12, weight: 3 },
];

/** Доп. % к лоту при повторе (со следующего вайпа можно убрать). */
export const REPEAT_EXTRA_PCT = 5;

export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const REPEAT_PROMO_DELAY_MS = 10_000;

export const PROFILE_UPSELL_DELAY_AFTER_PROMO_MS = 8000;

/** Текст для приветствия — без процентов случайного бонуса */
export function formatRandomBonusHintText() {
    return 'к лоту добавим случайный бонус';
}

export function rollWheelBonusPct() {
    const total = WHEEL_TIERS.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * total;
    for (const tier of WHEEL_TIERS) {
        r -= tier.weight;
        if (r <= 0) return tier.pct;
    }
    return WHEEL_TIERS[WHEEL_TIERS.length - 1].pct;
}

/** % → кк, не больше BONUS_MAX_KK */
export function wheelBonusKkFromPct(lotKk, pct) {
    const lot = Number(lotKk) || 0;
    const p = Number(pct) || 0;
    if (lot <= 0 || p <= 0) return 0;
    const raw = Math.round((lot * p) / 100);
    return Math.min(raw, BONUS_MAX_KK);
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

function repeatBonusKk(lotKk) {
    if (!REPEAT_EXTRA_PCT || REPEAT_EXTRA_PCT <= 0) return 0;
    const lot = Number(lotKk) || 0;
    if (lot <= 0) return 0;
    return Math.round((lot * REPEAT_EXTRA_PCT) / 100);
}

export function computeOrderPayout(lotKk, { bonusWheelKk = 0, bonusRepeatKk = 0 }) {
    const lot = Number(lotKk);
    const wheelKk = Math.max(0, Math.round(Number(bonusWheelKk) || 0));
    const repeatKk = Math.max(0, Math.round(Number(bonusRepeatKk) || 0));
    const payAmountKk = Math.max(1, lot + wheelKk + repeatKk);
    return {
        lotKk: lot,
        bonusWheelKk: wheelKk,
        bonusRepeatKk: repeatKk,
        payAmountKk,
        wheelPct: 0,
        repeatPct: 0,
        bonusTotalPct: 0,
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

    const rolledWheelPct = rollWheelBonusPct();
    const bonusWheelKk = wheelBonusKkFromPct(lotKk, rolledWheelPct);
    const bonusRepeatKk = buyerEligibleForRepeatBonus(state, order.buyerId ?? existing?.buyerId)
        ? repeatBonusKk(lotKk)
        : 0;
    const payout = computeOrderPayout(lotKk, { bonusWheelKk, bonusRepeatKk });

    const short = String(id).slice(0, 8);
    const capNote =
        bonusWheelKk < Math.round((lotKk * rolledWheelPct) / 100) ? ` (cap ${BONUS_MAX_KK}kk)` : '';
    const repeatNote = bonusRepeatKk > 0 ? `, повтор +${bonusRepeatKk}kk` : '';
    console.log(
        `[sell] бонус ${short}…: лот ${lotKk}kk, колесо +${rolledWheelPct}% → +${bonusWheelKk}kk${capNote}${repeatNote} → ${payout.payAmountKk}kk`,
    );

    const patch = {
        amountKk: payout.lotKk,
        bonusWheelPct: 0,
        bonusRepeatPct: bonusRepeatKk > 0 ? REPEAT_EXTRA_PCT : 0,
        bonusWheelKk: payout.bonusWheelKk,
        bonusRepeatKk: payout.bonusRepeatKk,
        bonusTotalPct: 0,
        payAmountKk: payout.payAmountKk,
        bonusComputedAt: new Date().toISOString(),
    };

    if (state.orders[id]) {
        Object.assign(state.orders[id], patch);
        return state.orders[id];
    }
    return { ...order, ...patch };
}
