/**
 * Отмена заказа покупателем (/cancel, бан+refund) запрещена,
 * если sellbot уже вложил деньги в казну клана.
 */
export function isBuyerOrderCancelBlocked(order) {
    return Boolean(order?.clanInvestedAt);
}
