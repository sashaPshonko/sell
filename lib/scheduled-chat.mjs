import { REPEAT_PROMO_DELAY_MS } from './pay-bonus.mjs';
import { buildRepeatPurchaseHint } from '../messages.mjs';
import { sendChatMessage } from '../chat.mjs';
import { getOrder, setOrderPhase } from '../state.mjs';

export function scheduleRepeatPromoMessage(state, chatId, orderId) {
    const order = getOrder(state, orderId);
    if (order?.repeatPromoScheduledAt) return;

    if (!state.scheduledChatMessages) state.scheduledChatMessages = [];

    const sendAtMs = Date.now() + REPEAT_PROMO_DELAY_MS;
    state.scheduledChatMessages.push({
        chatId,
        orderId,
        kind: 'repeat_promo',
        sendAtMs,
    });
    setOrderPhase(state, orderId, order?.phase ?? 'completed', {
        repeatPromoScheduledAt: new Date().toISOString(),
        repeatPromoSendAtMs: sendAtMs,
    });
}

export async function flushScheduledChatMessages(client, state) {
    const queue = state.scheduledChatMessages;
    if (!queue?.length) return;

    const now = Date.now();
    const remain = [];

    for (const item of queue) {
        if (item.sendAtMs > now) {
            remain.push(item);
            continue;
        }

        const order = item.orderId ? getOrder(state, item.orderId) : null;
        if (order?.repeatPromoSentAt) continue;

        try {
            const text =
                item.kind === 'repeat_promo'
                    ? buildRepeatPurchaseHint()
                    : item.text;
            if (!text) continue;
            await sendChatMessage(client, item.chatId, text);
            if (item.orderId && order) {
                setOrderPhase(state, item.orderId, order.phase, {
                    repeatPromoSentAt: new Date().toISOString(),
                });
            }
            console.log(
                `[sell] отложенное сообщение (${item.kind}) чат ${item.chatId.slice(0, 8)}…`,
            );
        } catch (e) {
            console.warn(`[sell] отложенное сообщение: ${e.message}`);
            if (Date.now() - item.sendAtMs < 3600_000) {
                remain.push({ ...item, sendAtMs: now + 30_000 });
            }
        }
    }

    state.scheduledChatMessages = remain;
}
