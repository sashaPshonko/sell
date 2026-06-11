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

/** Актуальный статус сделки из ленты (не PAID на момент ITEM_PAID). */
export function resolveDealStatus(timeline, dealId, fallbackStatus = null) {
    const snap = timeline?.get?.(dealId);
    return snap?.status ?? fallbackStatus ?? null;
}

/** Сделка ещё ждёт выдачи по PlayerOK. */
export function dealNeedsFulfillment(timeline, dealId, fallbackStatus = null) {
    const status = resolveDealStatus(timeline, dealId, fallbackStatus);
    if (!status) return false;
    return playerokNeedsDelivery(status);
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

/**
 * Повторный /nick не должен дублировать dispatch, пока sellbot реально выдаёт.
 * После сбоя (pausedUntilNick) — снова принимаем /nick.
 */
export function shouldIgnoreNickRedispatch(order) {
    if (!order) return true;
    if (isOrderFulfilled(order)) return true;
    if (order.pausedUntilNick) return false;
    if (
        order.clanWithdrawHintSentAt
        && (order.phase === 'dispatched' || order.phase === 'ws_pending')
    ) {
        return true;
    }
    return false;
}

/** Сброс клан-флагов при retry после кика / таймаута */
export function clanDeliveryRetryReset(extra = {}) {
    return {
        dispatchAckSentAt: undefined,
        queueStatusSentAt: undefined,
        deliveryHintSentAt: undefined,
        clanWithdrawHintSentAt: null,
        clanInviteHintSentAt: null,
        clanRemainderHintSentAt: null,
        clanRemainderHintWithdrawn: null,
        clanJoinedAt: null,
        ...extra,
    };
}

/** Уже выполнен (даже если phase в state застрял на dispatched/awaiting_nick) */
export function isOrderFulfilled(order) {
    if (!order) return true;
    if (order.phase === 'completed' || order.phase === 'cancelled') return true;
    if (order.gameDeliveryAt) return true;
    if (order.buyerNotifiedAt) return true;
    if (order.playerokMarkedAt) return true;
    if (order.playerokStatus && playerokIsClosed(order.playerokStatus)) {
        return true;
    }
    return false;
}

/** Привести phase к completed, если по фактам заказ уже закрыт */
export function reconcileFulfilledOrders(state) {
    for (const o of Object.values(state.orders || {})) {
        if (!o || !isOrderFulfilled(o)) continue;
        if (o.phase === 'completed' || o.phase === 'cancelled') continue;
        const oid = o.orderId || o.dealId;
        if (!oid) continue;
        setOrderPhase(state, oid, 'completed', {
            reconciledAt: new Date().toISOString(),
        });
        console.log(
            `[sell] заказ ${oid.slice(0, 8)}… → completed (сверка: было ${o.phase})`,
        );
    }
}

/** Локально ещё нужна выдача на сервере (не «dispatched» — повтор только по /nick) */
export function isFulfillmentOpen(order) {
    if (!order || isOrderFulfilled(order)) return false;
    if (order.phase === 'legacy' || order.phase === 'dispatched') return false;
    return true;
}

/** Можно слать в sellbot (после сбоя — только после нового /nick в чате) */
export function canDispatchToSellbot(order) {
    if (!isFulfillmentOpen(order)) return false;
    if (order.pausedUntilNick) return false;
    if (shouldIgnoreNickRedispatch(order)) return false;
    return true;
}

/** Есть ли у покупателя заказ, по которому ещё нужна выдача */
export function buyerHasFulfillmentOpen(state, chatId, buyerId) {
    return ordersInChat(state, chatId).some(
        (o) => o.buyerId === buyerId && isFulfillmentOpen(o),
    );
}

/** Любой незакрытый заказ (в т.ч. dispatched / ws_pending — новая оплата в том же чате) */
export function buyerHasPendingOrder(state, chatId, buyerId) {
    return ordersInChat(state, chatId).some(
        (o) => o.buyerId === buyerId && !isOrderFulfilled(o),
    );
}
