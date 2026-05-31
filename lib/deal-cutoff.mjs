/** Открытые заказы (PAID на PlayerOK) — без лимита «N минут с перезапуска». */

import { isFulfillmentOpen, playerokNeedsDelivery } from './playerok-deal-sync.mjs';

/** Каждый запуск `npm start` — метка сессии (логи). */
export function ensurePollStarted(state) {
    if (state._sellSessionStartMs) {
        return state.pollStartedAt;
    }

    state._sellSessionStartMs = Date.now();
    state.pollStartedAt = new Date(state._sellSessionStartMs).toISOString();

    const floor = process.env.PROCESS_DEALS_AFTER?.trim();
    if (floor) {
        console.log(`[sell] оплаты не раньше PROCESS_DEALS_AFTER=${floor}`);
    } else {
        console.log('[sell] все незакрытые заказы (PAID на PlayerOK), без окна по времени');
    }
    return state.pollStartedAt;
}

/** Только явный PROCESS_DEALS_AFTER в .env — иначе без отсечки по дате. */
export function getDealCutoffIso(state) {
    const explicit = process.env.PROCESS_DEALS_AFTER?.trim();
    return explicit || null;
}

export function isStaleDeal(paid, cutoffIso) {
    if (!cutoffIso || !paid?.paidAt) return false;
    return Date.parse(paid.paidAt) < Date.parse(cutoffIso);
}

/** Снять time-legacy и вернуть в работу заказы, которые ещё ждут выдачи. */
export function migrateStaleOrders(state, _cutoffIso = null) {
    for (const o of Object.values(state.orders || {})) {
        if (!o) continue;
        if (o.phase === 'completed' || o.phase === 'cancelled') continue;

        if (o.phase !== 'legacy') continue;

        const status = o.playerokStatus;
        if (status && !playerokNeedsDelivery(status)) continue;

        o.phase = 'awaiting_nick';
        const id = String(o.orderId || o.dealId || '').slice(0, 8);
        console.log(`[sell] заказ ${id}… снова в работе (был legacy)`);
    }
}

export function isActionableOrder(order) {
    return isFulfillmentOpen(order);
}
