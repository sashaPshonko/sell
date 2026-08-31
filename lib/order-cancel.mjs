/**
 * Отмена заказа покупателем (/cancel, бан+refund) запрещена,
 * если sellbot уже вложил деньги в казну клана
 * или последняя оплата — подписка botpodpopcorn.
 */
import { isSubscriptionLot, sameUserId } from '../parse.mjs';

export function isClanInvestCancelBlocked(order) {
    return Boolean(order?.clanInvestedAt);
}

export function isSubscriptionCancelBlocked(order) {
    return isSubscriptionLot(
        order?.itemName,
        order?.itemSlug || '',
        order?.itemId || '',
    );
}

export function isBuyerOrderCancelBlocked(order) {
    return isClanInvestCancelBlocked(order) || isSubscriptionCancelBlocked(order);
}

/** Последняя оплата покупателя до этого момента — лот подписки. */
export function latestPaidDealIsSubscription(messages, buyerId, beforeMs) {
    let latest = null;
    for (const msg of messages || []) {
        if (msg?.text !== '{{ITEM_PAID}}' || !msg.deal) continue;
        if (msg.deal.direction !== 'OUT') continue;
        const t = Date.parse(msg.createdAt);
        if (!Number.isFinite(t) || t > beforeMs) continue;
        const uid = msg.deal.user?.id;
        if (buyerId && uid && !sameUserId(uid, buyerId)) continue;
        if (!latest || t >= latest.t) {
            latest = { t, item: msg.deal.item };
        }
    }
    if (!latest) return false;
    return isSubscriptionLot(
        latest.item?.name,
        latest.item?.slug || '',
        latest.item?.id || '',
    );
}
