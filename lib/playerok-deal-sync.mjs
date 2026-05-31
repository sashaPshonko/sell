/**
 * Синхронизация заказов с PlayerOK по истории чата (chatMessages).
 * Источник правды: последний deal.status на каждый dealId в переписке.
 */
import { getOrder, setOrderPhase, ordersInChat } from '../state.mjs';

/** Нужна выдача на сервере + наши действия в чате */
export function playerokNeedsDelivery(status) {
    return status === 'PAID';
}

/** Сделка закрыта на PlayerOK (выдача с нашей стороны не нужна) */
export function playerokIsClosed(status) {
    return status === 'SENT' || status === 'CONFIRMED' || status === 'FINISHED';
}

export function playerokIsCancelled(status) {
    return status === 'ROLLED_BACK';
}

/**
 * Последний статус каждой сделки OUT из всех сообщений чата.
 * @returns {Map<string, { dealId, status, at, chatId, buyerId, buyer, itemId, itemName }>}
 */
export function buildDealStatusTimeline(messages) {
    const byId = new Map();

    for (const msg of messages) {
        const deal = msg?.deal;
        if (!deal?.id || deal.direction !== 'OUT' || !deal.status) continue;

        const at = msg.createdAt || '';
        const prev = byId.get(deal.id);
        if (prev && at && Date.parse(at) < Date.parse(prev.at)) continue;

        const item = deal.item;
        byId.set(deal.id, {
            dealId: deal.id,
            status: deal.status,
            at,
            chatId: deal.chat?.id || null,
            buyerId: deal.user?.id || null,
            buyer: deal.user?.username || null,
            itemId: item?.id || null,
            itemName: item?.name || null,
        });
    }

    return byId;
}

/**
 * Подтянуть phase/state.json к PlayerOK (без отмены «открытых» при новой оплате).
 */
export function syncChatOrdersFromPlayerok(state, chatId, timeline) {
    for (const snap of timeline.values()) {
        if (snap.chatId && snap.chatId !== chatId) continue;

        const oid = snap.dealId;
        const order = getOrder(state, oid);
        if (!order) continue;

        const statusChanged = order.playerokStatus !== snap.status;
        order.playerokStatus = snap.status;
        order.playerokStatusAt = snap.at;
        if (snap.itemId) order.itemId = snap.itemId;
        if (snap.itemName) order.itemName = snap.itemName;

        if (playerokIsCancelled(snap.status)) {
            if (order.phase !== 'cancelled' && order.phase !== 'completed') {
                setOrderPhase(state, oid, 'cancelled', {
                    lastError: 'playerok_rolled_back',
                });
                console.log(
                    `[sell] sync ${oid.slice(0, 8)}…: PlayerOK ${snap.status} → cancelled`,
                );
            }
            continue;
        }

        if (playerokIsClosed(snap.status)) {
            if (order.phase !== 'completed' && order.phase !== 'cancelled') {
                setOrderPhase(state, oid, 'completed', {
                    playerokSyncedAt: new Date().toISOString(),
                    ...(order.playerokMarkedAt ? {} : { playerokMarkedAt: snap.at }),
                });
                console.log(
                    `[sell] sync ${oid.slice(0, 8)}…: PlayerOK ${snap.status} → completed (не выдаём)`,
                );
            } else if (statusChanged) {
                console.log(
                    `[sell] sync ${oid.slice(0, 8)}…: PlayerOK ${snap.status}`,
                );
            }
        }
    }
}

/** Локально «открыт» и на PlayerOK ещё PAID — можно слать в sellbot */
export function isFulfillmentOpen(order) {
    if (!order) return false;
    if (order.phase === 'legacy' || order.phase === 'completed' || order.phase === 'cancelled') {
        return false;
    }
    if (order.gameDeliveryAt) {
        return false;
    }
    if (order.playerokStatus && !playerokNeedsDelivery(order.playerokStatus)) {
        return false;
    }
    return true;
}

/** То же, что isFulfillmentOpen — явное имя для dispatch/ws */
export function canDispatchToSellbot(order) {
    return isFulfillmentOpen(order);
}

/** Есть ли у покупателя заказ, по которому ещё нужна выдача */
export function buyerHasFulfillmentOpen(state, chatId, buyerId) {
    return ordersInChat(state, chatId).some(
        (o) => o.buyerId === buyerId && isFulfillmentOpen(o),
    );
}
