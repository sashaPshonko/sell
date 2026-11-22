/**
 * Покупатель после автовозврата (profile-upsell) пишет в чат ник / «/cancel» / что угодно —
 * открытых заказов нет, и раньше бот молчал. Теперь отвечаем напоминанием: заказ отменён,
 * деньги на балансе, ссылка на 🎁-лот.
 *
 * Не чаще одного ответа на пачку сообщений (ответ — после самого свежего сообщения покупателя),
 * не больше REMINDER_MAX на заказ, только в течение REMINDER_WINDOW_MS после возврата.
 * Если после покупателя уже писал продавец (ты вручную) — молчим.
 */

import { isBuyerUser, sameUserId } from '../parse.mjs';
import { ordersInChat, setOrderPhase } from '../state.mjs';

export const REMINDER_MAX = 3;
export const REMINDER_WINDOW_MS = 24 * 3600_000;

const ts = (iso) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * @returns {{ order: object, lastBuyerAt: string } | null}
 */
export function pickRefundReminder(state, chatId, messages, sellerUserId, nowMs = Date.now()) {
    const inChat = ordersInChat(state, chatId);
    const refunded = inChat
        .filter((o) => o.phase === 'cancelled' && o.cancelReason === 'profile_upsell_refund')
        .filter((o) => o.premiumRefundUpsellSentAt && o.profileUpsellUrl)
        .sort((a, b) => ts(b.premiumRefundUpsellSentAt) - ts(a.premiumRefundUpsellSentAt));
    const order = refunded[0];
    if (!order) return null;
    const refundAt = ts(order.premiumRefundUpsellSentAt);
    if (nowMs - refundAt > REMINDER_WINDOW_MS) return null;
    if ((order.refundReminderCount || 0) >= REMINDER_MAX) return null;
    // После возврата он уже что-то купил — дальше обычная выдача, не мешаем
    if (inChat.some((o) => o !== order && ts(o.paidAt) > refundAt)) return null;

    const since = Math.max(refundAt, ts(order.refundReminderAt));
    let lastBuyer = null;
    let lastSellerMs = 0;
    for (const m of messages || []) {
        if (!m?.text || m.deal) continue;
        const at = ts(m.createdAt);
        if (isBuyerUser(m, order.buyerId, order.buyer)) {
            if (at > since && (!lastBuyer || at > ts(lastBuyer.createdAt))) lastBuyer = m;
        } else if (sellerUserId && sameUserId(m.user?.id, sellerUserId)) {
            if (at > lastSellerMs) lastSellerMs = at;
        }
    }
    if (!lastBuyer) return null;
    if (lastSellerMs > ts(lastBuyer.createdAt)) return null; // продавец уже ответил сам
    return { order, lastBuyerAt: lastBuyer.createdAt };
}

/**
 * @param {(chatId: string, text: string) => Promise<unknown>} send
 * @param {(order: object) => string} buildText
 */
export async function remindAfterUpsellRefund(state, chatId, messages, sellerUserId, send, buildText) {
    const pick = pickRefundReminder(state, chatId, messages, sellerUserId);
    if (!pick) return false;
    const { order } = pick;
    try {
        await send(chatId, buildText(order));
    } catch (e) {
        console.warn(`[sell] напоминание после автовозврата: ${e.message}`);
        return false;
    }
    setOrderPhase(state, order.orderId, order.phase, {
        refundReminderAt: new Date().toISOString(),
        refundReminderCount: (order.refundReminderCount || 0) + 1,
    });
    console.log(
        `[sell] автовозврат ${String(order.orderId).slice(0, 8)}…: покупатель пишет после возврата → напомнил про ссылку`,
    );
    return true;
}
