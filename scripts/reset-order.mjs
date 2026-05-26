/**
 * Сброс заказа для повторного теста (ник → ws → delivery_ok → PlayerOK).
 *
 *   npm run reset-order
 *   npm run reset-order -- 1f158583-2837-6b80-0349-8db5ee985525
 */
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadEnv, projectRoot } from '../lib/env.mjs';

loadEnv();

const DEFAULT_DEAL = '1f158583-2837-6b80-0349-8db5ee985525';
const dealId = process.argv[2]?.trim() || DEFAULT_DEAL;
const statePath = join(projectRoot, process.env.STATE_FILE || 'state.json');

if (!existsSync(statePath)) {
    console.error(`нет ${statePath}`);
    process.exit(1);
}

const state = JSON.parse(await readFile(statePath, 'utf8'));
const order = state.orders?.[dealId];
if (!order) {
    console.error(`заказ не найден: ${dealId}`);
    process.exit(1);
}

const chatId = order.chatId;
order.phase = 'awaiting_nick';
order.nick = null;
delete order.dispatchedAt;
delete order.playerokMarkedAt;
delete order.playerokStatus;
delete order.lastError;
delete order.lateNickHandled;
delete order.seenMessageIds;

const chat = state.chats?.[chatId];
if (chat?.buyers?.[order.buyerId]) {
    const buyer = chat.buyers[order.buyerId];
    delete buyer.nick;
    delete buyer.via;
    delete buyer.messageId;
    delete buyer.nickAt;
    delete buyer.wrongNickWarned;
    buyer.nickResetAt = new Date().toISOString();
}
if (chat) {
    chat.processedNickMessageIds = [];
}

await writeFile(statePath, JSON.stringify(state, null, 2));
console.log(`[reset-order] ${dealId.slice(0, 8)}… → awaiting_nick (чат ${chatId?.slice(0, 8)}…)`);
console.log('[reset-order] в PlayerOK напиши: /nick твой-ник');
