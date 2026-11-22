import {
    isMergePrimaryLive,
    mergeEnabled,
    mergedTotalPay,
    mergeIntoPrimary,
} from './lib/order-merge.mjs';
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

    // Приклеенный к другому заказу (lib/order-merge.mjs) — отдельно в sellbot не шлём никогда:
    // он едет в переводе основного; если основной сорвался, poll (healMergedOrders) его отвяжет.
    if (state && existing?.mergedInto) {
        const prim = state.orders[existing.mergedInto];
        const live = prim && isMergePrimaryLive(prim) && (prim.mergedOrderIds || []).includes(oid);
        console.log(
            `[dispatch] ${oid?.slice(0, 8)}… едет с основным ${existing.mergedInto.slice(0, 8)}…${live ? '' : ' (основной не в выдаче — ждём разбор группы)'}, отдельно не шлём`,
        );
        return { sent: 1, merged: true };
    }
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

    // Объединение заказов одного покупателя в один перевод (lib/order-merge.mjs)
    let mergedAmount = null;
    if (state && existing && mergeEnabled()) {
        if ((existing.mergedOrderIds || []).length) {
            mergedAmount = mergedTotalPay(state, existing);
        } else if (!opts.resync) {
            const m = mergeIntoPrimary(
                state,
                {
                    ...existing,
                    ...order,
                    orderId: oid,
                    chatId: order.chatId ?? existing.chatId,
                    buyerId: order.buyerId ?? existing.buyerId,
                },
                order.nick,
            );
            if (m) mergedAmount = m.total;
        }
    } else if (state && existing && (existing.mergedOrderIds || []).length) {
        // MERGE_ORDERS=0 включили, когда группа уже в пути — сумму группы всё равно держим
        mergedAmount = mergedTotalPay(state, existing);
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
        amount: mergedAmount ?? order.payAmountKk ?? order.amountKk,
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
