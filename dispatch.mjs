import { DELIVERY_ANARCHY } from './messages.mjs';

/** По умолчанию — клиент к sellbot; встроенный hub только при WS_EMBEDDED=1 */
const useClient = process.env.WS_DISABLE !== '1' && process.env.WS_EMBEDDED !== '1';

let hub;
let client;

async function getTransport() {
    if (process.env.WS_DISABLE === '1') {
        return null;
    }
    if (useClient) {
        if (!client) {
            client = await import('./lib/ws-client.mjs');
            client.startWsClient();
        }
        return client;
    }
    if (!hub) {
        hub = await import('./lib/ws-hub.mjs');
        hub.startWsHub();
    }
    return hub;
}

/** Отправить заказ ботам по WebSocket */
export async function dispatchOrder(order) {
    const t = await getTransport();
    if (!t) {
        console.warn('[dispatch] WS отключён');
        return { sent: 0 };
    }
    const payload = {
        orderId: order.orderId,
        dealId: order.dealId,
        chatId: order.chatId,
        buyer: order.buyer,
        buyerId: order.buyerId,
        nick: order.nick,
        amount: order.payAmountKk ?? order.amountKk,
        paidAtMs: order.paidAtMs ?? (order.paidAt ? Date.parse(order.paidAt) : undefined),
        anarchy: DELIVERY_ANARCHY(),
        itemName: order.itemName,
        server: order.server || null,
    };
    return t.pushOrder(payload);
}

export async function dispatchNickUpdate(orderId, nick) {
    const t = await getTransport();
    if (!t) return;
    return t.pushNickUpdate(orderId, nick);
}

export async function dispatchCancelOrder(orderId) {
    const t = await getTransport();
    if (!t?.pushCancelOrder) return;
    return t.pushCancelOrder(orderId);
}

export async function drainBotEvents() {
    const t = await getTransport();
    if (!t) return [];
    return t.drainBotEvents();
}
