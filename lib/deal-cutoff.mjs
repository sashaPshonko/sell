/** Открытые заказы (PAID на PlayerOK) — без лимита «N минут с перезапуска». */

import {
    isFulfillmentOpen,
    isOrderFulfilled,
    playerokNeedsDelivery,
    reconcileFulfilledOrders,
} from './playerok-deal-sync.mjs';
import { setOrderPhase } from '../state.mjs';

const DISPATCH_STALE_MS = Number(process.env.DISPATCH_STALE_MS || 3_600_000);

/** dispatched давно без delivery_ok — не крутить /pay каждый poll */
export function reconcileStuckDispatched(state) {
    const now = Date.now();
    for (const o of Object.values(state.orders || {})) {
        if (!o || o.phase !== 'dispatched' || o.gameDeliveryAt) continue;
        const at = o.dispatchedAt ? Date.parse(o.dispatchedAt) : 0;
        if (!at || now - at < DISPATCH_STALE_MS) continue;
        const oid = o.orderId || o.dealId;
        if (!oid) continue;
        setOrderPhase(state, oid, 'completed', {
            stuckDispatchedAt: new Date().toISOString(),
            lastError: 'dispatch_stale',
        });
        console.log(
            `[sell] заказ ${oid.slice(0, 8)}… → completed (dispatched >${Math.round(DISPATCH_STALE_MS / 60_000)}м без выдачи в игре)`,
        );
    }
}

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
    reconcileFulfilledOrders(state);
    reconcileStuckDispatched(state);
    for (const o of Object.values(state.orders || {})) {
        if (!o) continue;
        if (isOrderFulfilled(o) && o.phase !== 'completed' && o.phase !== 'cancelled') {
            o.phase = 'completed';
            const id = String(o.orderId || o.dealId || '').slice(0, 8);
            console.log(`[sell] заказ ${id}… → completed (миграция)`);
            continue;
        }
        if (o.gameDeliveryAt && o.phase !== 'completed' && o.phase !== 'cancelled') {
            o.phase = 'completed';
            const id = String(o.orderId || o.dealId || '').slice(0, 8);
            console.log(`[sell] заказ ${id}… → completed (уже выдано в игре)`);
            continue;
        }
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
