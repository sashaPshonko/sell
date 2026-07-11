/**
 * Выплата = лот + случайный % (с потолком в кк).
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

/** Задержка перед первым upsell после выдачи */
export const POST_DELIVERY_CHAT_DELAY_MS = 10_000;

/** Повтор ссылки на 🎁, если за это время не купили */
export const UPSELL_REPEAT_DELAY_MS = 40_000;

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

export function computeOrderPayout(lotKk, { bonusWheelKk = 0 } = {}) {
    const lot = Number(lotKk);
    const wheelKk = Math.max(0, Math.round(Number(bonusWheelKk) || 0));
    const payAmountKk = Math.max(1, lot + wheelKk);
    return {
        lotKk: lot,
        bonusWheelKk: wheelKk,
        payAmountKk,
        wheelPct: 0,
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
    const payout = computeOrderPayout(lotKk, { bonusWheelKk });

    const short = String(id).slice(0, 8);
    const capNote =
        bonusWheelKk < Math.round((lotKk * rolledWheelPct) / 100) ? ` (cap ${BONUS_MAX_KK}kk)` : '';
    console.log(
        `[sell] бонус ${short}…: лот ${lotKk}kk, колесо +${rolledWheelPct}% → +${bonusWheelKk}kk${capNote} → ${payout.payAmountKk}kk`,
    );

    const patch = {
        amountKk: payout.lotKk,
        bonusWheelPct: 0,
        bonusWheelKk: payout.bonusWheelKk,
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
