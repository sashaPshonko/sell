/**
 * Возврат всем незакрытым заказам + извинение в чат (проблемы с интернетом).
 *
 *   node scripts/refund-active-internet.mjs
 */
import { loadEnv, projectRoot } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';
import { loadState, saveState, setOrderPhase } from '../state.mjs';
import { isOrderFulfilled } from '../lib/playerok-deal-sync.mjs';
import { isBuyerOrderCancelBlocked } from '../lib/order-cancel.mjs';
import { cancelDealOnPlayerok } from '../cancel.mjs';
import { dispatchCancelOrder } from '../dispatch.mjs';
import { sendChatMessage } from '../chat.mjs';

loadEnv();

const APOLOGY = [
    'Привет. Извини, пожалуйста — были проблемы с интернетом, поэтому заказ вовремя выдать не получилось.',
    '',
    'Оплату возвращаю на баланс PlayerOK.',
    '',
    'Если деньги не пришли — напиши в поддержку PlayerOK.',
].join('\n');

function isOpen(order) {
    if (!order) return false;
    if (order.phase === 'completed' || order.phase === 'cancelled') return false;
    if (isOrderFulfilled(order)) return false;
    return true;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

const state = await loadState();
const orders = Object.values(state.orders || {}).filter(isOpen);
console.log(`[refund] открытых заказов: ${orders.length}`);
for (const o of orders) {
    const id = String(o.orderId || o.dealId || '');
    console.log(
        `  ${id.slice(0, 8)}… phase=${o.phase} kk=${o.amountKk ?? '?'} clan=${Boolean(o.clanInvestedAt)} chat=${String(o.chatId || '').slice(0, 8)}…`,
    );
}

if (!orders.length) {
    process.exit(0);
}

const client = createClient();
const chats = new Map();
let refunded = 0;
let skippedClan = 0;
let pokOk = 0;
let pokFail = 0;

for (const order of orders) {
    const oid = order.orderId || order.dealId;
    if (isBuyerOrderCancelBlocked(order)) {
        skippedClan += 1;
        console.log(`[refund] пропуск (деньги в казне) ${String(oid).slice(0, 8)}…`);
        continue;
    }

    const wasDispatched = order.phase === 'dispatched' || order.phase === 'ws_pending';
    setOrderPhase(state, oid, 'cancelled', {
        cancelledAt: new Date().toISOString(),
        cancelReason: 'internet_outage_refund',
    });
    if (wasDispatched) {
        try {
            await dispatchCancelOrder(oid, state);
        } catch (e) {
            console.warn(`[refund] sellbot cancel ${String(oid).slice(0, 8)}…: ${e.message}`);
        }
    }

    if (process.env.AUTO_CANCEL_PLAYEROK === '1') {
        try {
            await cancelDealOnPlayerok(client, oid);
            setOrderPhase(state, oid, 'cancelled', {
                playerokCancelledAt: new Date().toISOString(),
            });
            pokOk += 1;
            console.log(`[refund] PlayerOK ROLLED_BACK ${String(oid).slice(0, 8)}…`);
        } catch (e) {
            pokFail += 1;
            console.warn(`[refund] PlayerOK ${String(oid).slice(0, 8)}…: ${e.message}`);
        }
        await sleep(700);
    } else {
        console.warn('[refund] AUTO_CANCEL_PLAYEROK≠1 — только локальная отмена');
    }

    refunded += 1;
    if (order.chatId) {
        if (!chats.has(order.chatId)) chats.set(order.chatId, []);
        chats.get(order.chatId).push(oid);
    }
}

await saveState(state);

for (const [chatId, ids] of chats) {
    try {
        await sendChatMessage(client, chatId, APOLOGY);
        console.log(`[refund] чат ${chatId.slice(0, 8)}… извинение (${ids.length} зак.)`);
    } catch (e) {
        console.warn(`[refund] чат ${chatId.slice(0, 8)}…: ${e.message}`);
    }
    await sleep(600);
}

console.log(
    `[refund] готово: отменено=${refunded} playerok_ok=${pokOk} playerok_fail=${pokFail} казна_пропуск=${skippedClan} чатов=${chats.size}`,
);
console.log(`cwd state: ${projectRoot}`);
