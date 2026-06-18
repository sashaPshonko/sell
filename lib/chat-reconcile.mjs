/**
 * Сверка заказов с PlayerOK по deal.status в ленте чата.
 * Наши сообщения («Валюта выдана») не используем — в одном чате их несколько, легко перепутать заказы.
 */
import { ordersInChat } from '../state.mjs';
import {
    buildDealStatusTimeline,
    isOrderFulfilled,
    syncChatOrdersFromPlayerok,
} from './playerok-deal-sync.mjs';
import { flattenMessages } from '../parse.mjs';

/** Подтянуть старые страницы chatMessages (статусы SENT выше ленты). */
export async function fetchChatMessagesDeep(client, chatId) {
    const perPage = Number(process.env.CHAT_MESSAGES_FIRST || 20);
    const maxPages = Number(process.env.CHAT_MESSAGES_MAX_PAGES || 15);
    const byId = new Map();

    let after = null;
    for (let page = 0; page < maxPages; page++) {
        const data = await client.chatMessages(chatId, perPage, after);
        const nodes = flattenMessages(data);
        for (const n of nodes) {
            if (n?.id) byId.set(n.id, n);
        }
        const pi = data?.chatMessages?.pageInfo;
        if (!pi?.hasNextPage || !pi?.endCursor) break;
        after = pi.endCursor;
    }

    return [...byId.values()].sort(
        (a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0),
    );
}

export function chatHasStuckOrders(state, chatId) {
    return ordersInChat(state, chatId).some((o) => {
        if (isOrderFulfilled(o)) return false;
        return (
            o.phase === 'dispatched'
            || o.phase === 'awaiting_nick'
            || o.phase === 'ws_pending'
            || Boolean(o.dispatchedAt)
        );
    });
}

/** Закрытие только по deal.status PlayerOK в сообщениях чата (SENT / CONFIRMED / …). */
export function reconcileOrdersFromChatHistory(state, chatId, messages) {
    const timeline = buildDealStatusTimeline(messages);
    syncChatOrdersFromPlayerok(state, chatId, timeline);
}
