/**
 * Закрытие заказов по старой истории чата (сообщение «выдано» / SENT в ленте).
 */
import { ordersInChat, setOrderPhase } from '../state.mjs';
import {
    buildDealStatusTimeline,
    isOrderFulfilled,
    playerokIsClosed,
    syncChatOrdersFromPlayerok,
} from './playerok-deal-sync.mjs';
import { flattenMessages } from '../parse.mjs';

const DELIVERY_MARKERS = [
    'Валюта выдана',
    'Заказ уже выполнен',
];

function messageMarksDelivery(msg, sellerUserId, order) {
    if (!msg?.text || msg.user?.id !== sellerUserId) return false;
    const text = msg.text;
    if (!DELIVERY_MARKERS.some((m) => text.includes(m))) return false;

    const payKk = order.payAmountKk ?? order.amountKk;
    const lotKk = order.amountKk;
    if (text.includes('Заказ уже выполнен')) return true;
    if (payKk && (text.includes(`${payKk}kk`) || text.includes(`${payKk} kk`))) {
        return true;
    }
    if (lotKk && payKk !== lotKk && text.includes(`${lotKk}kk`)) {
        return true;
    }
    return false;
}

/** Подтянуть старые страницы chatMessages (SENT / «выдано» выше ленты из 40 сообщений). */
export async function fetchChatMessagesDeep(client, chatId) {
    const perPage = Number(process.env.CHAT_MESSAGES_FIRST || 40);
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

/** SENT в ленте + наши «Валюта выдана» с суммой → completed в state */
export function reconcileOrdersFromChatHistory(state, chatId, messages, sellerUserId) {
    const timeline = buildDealStatusTimeline(messages);
    syncChatOrdersFromPlayerok(state, chatId, timeline);

    for (const order of ordersInChat(state, chatId)) {
        if (isOrderFulfilled(order)) continue;
        const oid = order.orderId || order.dealId;
        if (!oid) continue;

        const snap = timeline.get(oid);
        if (snap && playerokIsClosed(snap.status)) {
            setOrderPhase(state, oid, 'completed', {
                playerokStatus: snap.status,
                playerokStatusAt: snap.at,
                chatReconciledAt: new Date().toISOString(),
            });
            console.log(
                `[sell] ${oid.slice(0, 8)}…: из истории чата PlayerOK ${snap.status} → completed`,
            );
            continue;
        }

        for (const msg of messages) {
            if (!messageMarksDelivery(msg, sellerUserId, order)) continue;
            const at = msg.createdAt || new Date().toISOString();
            setOrderPhase(state, oid, 'completed', {
                gameDeliveryAt: order.gameDeliveryAt || at,
                buyerNotifiedAt: order.buyerNotifiedAt || at,
                chatReconciledAt: new Date().toISOString(),
            });
            console.log(
                `[sell] ${oid.slice(0, 8)}…: в истории чата «выдано» (${at.slice(0, 10)}) → completed`,
            );
            break;
        }
    }
}
