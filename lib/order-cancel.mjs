/**
 * Отмена заказа покупателем (/cancel, бан+refund) запрещена,
 * если sellbot уже вложил деньги в казну клана
 * или это подписка botpodpopcorn (валюту в том же чате /cancel всё ещё снимает).
 */
import { isSubscriptionLot } from '../parse.mjs';

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
