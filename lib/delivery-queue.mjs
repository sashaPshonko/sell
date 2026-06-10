/** Снимок очереди sellbot (delivery_queue по ws). */

let snapshot = { active: null, waiting: [] };

export function setDeliveryQueueSnapshot(ev) {
    snapshot = {
        active: ev?.active ?? null,
        waiting: Array.isArray(ev?.waiting) ? ev.waiting : [],
        at: ev?.at || new Date().toISOString(),
    };
}

export function getQueueTotal() {
    return (snapshot.active ? 1 : 0) + snapshot.waiting.length;
}

/** @returns {{ position: number, total: number, isActive: boolean, inQueue: boolean, ahead: number }} */
export function getQueuePosition(orderId) {
    if (!orderId) {
        return { position: 0, total: getQueueTotal(), isActive: false, inQueue: false, ahead: 0 };
    }
    const ids = [];
    if (snapshot.active?.orderId) ids.push(snapshot.active.orderId);
    for (const o of snapshot.waiting) ids.push(o.orderId);
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

export function isQueueBusy() {
    return Boolean(snapshot.active) || snapshot.waiting.length > 0;
}
