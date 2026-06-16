/** Снимок очереди sellbot (delivery_queue по ws). */

import { getOrder } from '../state.mjs';
import { isOrderFulfilled } from './playerok-deal-sync.mjs';

let snapshot = { active: null, waiting: [] };

export function setDeliveryQueueSnapshot(ev) {
    snapshot = {
        active: ev?.active ?? null,
        waiting: Array.isArray(ev?.waiting) ? ev.waiting : [],
        at: ev?.at || new Date().toISOString(),
    };
}

/** Заказ реально в выдаче (не завершён, не на паузе до нового /nick). */
export function isLiveQueueOrder(state, orderId) {
    if (!orderId) return false;
    const order = getOrder(state, orderId);
    if (!order) return false;
    if (isOrderFulfilled(order)) return false;
    if (order.pausedUntilNick) return false;
    return order.phase === 'dispatched' || order.phase === 'ws_pending';
}

function liveQueueOrderIds(state) {
    const ids = [];
    if (snapshot.active?.orderId && isLiveQueueOrder(state, snapshot.active.orderId)) {
        ids.push(snapshot.active.orderId);
    }
    for (const o of snapshot.waiting) {
        if (o?.orderId && isLiveQueueOrder(state, o.orderId)) {
            ids.push(o.orderId);
        }
    }
    return ids;
}

export function getQueueTotal(state = null) {
    if (state) return liveQueueOrderIds(state).length;
    return (snapshot.active ? 1 : 0) + snapshot.waiting.length;
}

/** @returns {{ position: number, total: number, isActive: boolean, inQueue: boolean, ahead: number }} */
export function getQueuePosition(orderId, state = null) {
    const ids = state ? liveQueueOrderIds(state) : (() => {
        const raw = [];
        if (snapshot.active?.orderId) raw.push(snapshot.active.orderId);
        for (const o of snapshot.waiting) raw.push(o.orderId);
        return raw;
    })();

    if (!orderId) {
        return { position: 0, total: ids.length, isActive: false, inQueue: false, ahead: ids.length };
    }
    const idx = ids.indexOf(orderId);
    if (idx < 0) {
        return {
            position: 0,
            total: ids.length,
            isActive: false,
            inQueue: false,
            ahead: ids.length,
        };
    }
    return {
        position: idx + 1,
        total: ids.length,
        isActive: idx === 0,
        inQueue: true,
        ahead: idx,
    };
}

export function isQueueBusy(state = null) {
    return getQueueTotal(state) > 0;
}
