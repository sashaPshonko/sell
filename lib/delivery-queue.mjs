/** Снимок очереди sellbot (delivery_queue по ws) + локальный порядок по paidAt. */

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

function paidAtMs(order) {
    const fromIso = order?.paidAt ? Date.parse(order.paidAt) : NaN;
    if (Number.isFinite(fromIso)) return fromIso;
    const raw = Number(order?.paidAtMs);
    return Number.isFinite(raw) ? raw : 0;
}

/**
 * Локальная очередь: все live dispatched/ws_pending, по времени оплаты.
 * Нужна сразу после dispatch — снимок sellbot может ещё не прийти.
 */
export function localLiveQueueIds(state) {
    const list = [];
    for (const o of Object.values(state?.orders || {})) {
        const id = o?.orderId || o?.dealId;
        if (!isLiveQueueOrder(state, id)) continue;
        list.push({ id, t: paidAtMs(o) });
    }
    list.sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)));
    return list.map((x) => x.id);
}

function snapshotQueueIds(state) {
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

/**
 * Порядок для позиции в чате: локальный paidAt (полный),
 * если снимок sellbot есть — предпочитаем его порядок для пересечения id.
 */
function liveQueueOrderIds(state) {
    const local = localLiveQueueIds(state);
    const snap = snapshotQueueIds(state);
    if (!snap.length) return local;

    const localSet = new Set(local);
    const ordered = [];
    const seen = new Set();
    for (const id of snap) {
        if (!localSet.has(id) || seen.has(id)) continue;
        ordered.push(id);
        seen.add(id);
    }
    for (const id of local) {
        if (seen.has(id)) continue;
        ordered.push(id);
        seen.add(id);
    }
    return ordered;
}

export function getQueueTotal(state = null) {
    if (state) return liveQueueOrderIds(state).length;
    return (snapshot.active ? 1 : 0) + snapshot.waiting.length;
}

/** @returns {{ position: number, total: number, isActive: boolean, inQueue: boolean, ahead: number }} */
export function getQueuePosition(orderId, state = null) {
    const ids = state
        ? liveQueueOrderIds(state)
        : (() => {
              const raw = [];
              if (snapshot.active?.orderId) raw.push(snapshot.active.orderId);
              for (const o of snapshot.waiting) {
                  if (o?.orderId) raw.push(o.orderId);
              }
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
