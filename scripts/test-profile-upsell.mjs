#!/usr/bin/env node
/**
 * Проверка profile-upsell: node scripts/test-profile-upsell.mjs [baseKk] [priceRub]
 * Пример: node scripts/test-profile-upsell.mjs 100 169
 */
import { loadEnv } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';
import { resolveProfileUpsell, profileUpsellEmoji } from '../lib/profile-upsell.mjs';
import { buildProfileUpsellHint } from '../messages.mjs';

loadEnv();

const baseKk = Number(process.argv[2] || 100);
const priceRub = Number(process.argv[3] || 0) || null;

const client = createClient();
const viewer = await client.viewer();
const sellerUserId = viewer.viewer.id;

const order = {
    amountKk: baseKk,
    itemPriceRub: priceRub,
    itemName: `${baseKk}kk FUNTIME`,
};

console.log(`seller=${viewer.viewer.username} emoji=${profileUpsellEmoji()}`);
console.log(`order: ${order.itemName} price=${priceRub ?? '?'}`);

const match = await resolveProfileUpsell(
    client,
    order,
    sellerUserId,
    viewer.viewer.username,
);
if (!match) {
    console.log('match: нет (проверь ⭐ в названии профильных лотов и цену)');
    process.exit(1);
}

console.log('match:', match);
console.log('---');
console.log(buildProfileUpsellHint({
    emoji: match.emoji,
    upsellKk: match.kk,
    baseKk: match.baseKk,
    priceRub: match.priceRub,
    url: match.url,
}));
