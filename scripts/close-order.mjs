/**
 * Пометить заказ выполненным (sell перестанет слать в sellbot).
 *
 *   npm run close-order -- 1f15d027-….
 */
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadEnv, projectRoot } from '../lib/env.mjs';

loadEnv();

const dealId = process.argv[2]?.trim();
if (!dealId) {
    console.error('укажи dealId: npm run close-order -- <uuid>');
    process.exit(1);
}

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

const now = new Date().toISOString();
order.phase = 'completed';
order.gameDeliveryAt = order.gameDeliveryAt || now;
order.playerokMarkedAt = order.playerokMarkedAt || now;
if (!order.playerokStatus || order.playerokStatus === 'PAID') {
    order.playerokStatus = 'SENT';
}
order.playerokStatusAt = order.playerokStatusAt || now;

await writeFile(statePath, JSON.stringify(state, null, 2));
console.log(`[close-order] ${dealId.slice(0, 8)}… → completed`);
console.log('[close-order] перезапусти poll.mjs — уйдёт cancel в sellbot');
