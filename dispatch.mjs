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

/** Отправить заказ ботам по WebSocket
 * @param {{ force?: boolean, resync?: boolean }} opts
 * force — обойти canDispatch (для resync dispatched после рестарта sellbot)
 */
export async function dispatchOrder(order, state = null, opts = {}) {
    const force = Boolean(opts.force || opts.resync);
    const oid = order.orderId || order.dealId;
    const existing = state?.orders?.[oid];
    if (existing) {
        const { canDispatchToSellbot, isBotFatalPaused } = await import(
            './lib/playerok-deal-sync.mjs'
        );
        if (isBotFatalPaused(existing)) {
            console.log(
                `[dispatch] пропуск ${oid?.slice(0, 8)}… (bot fatal: ${existing.lastError})`,
            );
            return { sent: 0, skipped: true };
        }
        if (!force && !canDispatchToSellbot(existing)) {
            console.log(
                `[dispatch] пропуск ${oid?.slice(0, 8)}… (заказ закрыт, phase=${existing.phase})`,
            );
            void dispatchCancelOrder(oid, state);
            return { sent: 0, skipped: true };
        }
    }

    const t = await getTransport();
    if (!t) {
        console.warn('[dispatch] WS отключён');
        return { sent: 0 };
    }
    const priorWithdrawn = Number(
        existing?.clanPlayerWithdrawn ?? order.clanPlayerWithdrawn ?? 0,
    );
    const payload = {
        orderId: order.orderId,
        dealId: order.dealId,
        chatId: order.chatId,
        buyer: order.buyer,
        buyerId: order.buyerId,
        nick: order.nick,
        amount: order.payAmountKk ?? order.amountKk,
        paidAtMs: order.paidAtMs ?? (order.paidAt ? Date.parse(order.paidAt) : undefined),
        anarchy: DELIVERY_ANARCHY,
        itemName: order.itemName,
        server: order.server || null,
        priorWithdrawn: priorWithdrawn > 0 ? priorWithdrawn : undefined,
        resync: Boolean(opts.resync) || undefined,
    };
    return t.pushOrder(payload);
}

export async function dispatchNickUpdate(orderId, nick) {
    const t = await getTransport();
    if (!t) return;
    return t.pushNickUpdate(orderId, nick);
}

export async function dispatchCancelOrder(orderId, state = null) {
    if (state) {
        const { getOrder } = await import('./state.mjs');
        const { isBuyerOrderCancelBlocked } = await import('./lib/order-cancel.mjs');
        const order = getOrder(state, orderId);
        if (order && isBuyerOrderCancelBlocked(order)) {
            console.log(`[dispatch] ❌ Отмена запрещена: деньги в казне ${orderId.slice(0, 8)}…`);
            return;
        }
    }
    const t = await getTransport();
    if (!t?.pushCancelOrder) return;
    return t.pushCancelOrder(orderId);
}

export async function drainBotEvents() {
    const t = await getTransport();
    if (!t) return [];
    return t.drainBotEvents();
}
