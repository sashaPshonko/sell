/**
 * Ручной тест перевыставления.
 *
 * npm run test-publish -- <itemId> [priceRub]
 * npm run test-publish -- --slug e65e10525c98-270kk-momentalno-bonus
 * npm run test-publish -- --kk 60 --price 119 [--gift]
 */
import { loadEnv } from '../lib/env.mjs';
import { assertPlayerokAuth } from '../lib/check-auth.mjs';
import { createClient } from '../playerok-client.mjs';
import { publishItemOnPlayerok } from '../publish.mjs';
import { isMarkedProfileLot, PROFILE_LOT_MARKER } from '../lib/profile-upsell.mjs';
import { resolveCompletedItemForOrder } from '../lib/completed-republish.mjs';
import { discountedPriceRub, guessItemSlug } from '../parse.mjs';

loadEnv();

const args = process.argv.slice(2);
let itemId = null;
let priceRub = null;
let slug = null;
let itemName = null;
let amountKk = null;
let gift = false;

for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--slug' && args[i + 1]) {
        slug = args[++i].trim();
        continue;
    }
    if (a === '--name' && args[i + 1]) {
        itemName = args[++i].trim();
        continue;
    }
    if (a === '--kk' && args[i + 1]) {
        amountKk = Number(args[++i]);
        continue;
    }
    if (a === '--price' && args[i + 1]) {
        priceRub = Number(args[++i]);
        continue;
    }
    if (a === '--gift') {
        gift = true;
        continue;
    }
    if (!itemId && !a.startsWith('-')) {
        itemId = a.trim();
        continue;
    }
    if (priceRub == null && !a.startsWith('-') && itemId) {
        priceRub = Number(a);
    }
}

if (!itemId && !slug && amountKk == null) {
    console.error('Использование:');
    console.error('  npm run test-publish -- <itemId> [priceRub] [--name "270КК 🎁"]');
    console.error('  npm run test-publish -- --slug <slug>');
    console.error('  npm run test-publish -- --kk 60 --price 119 [--gift]');
    process.exit(1);
}

await assertPlayerokAuth();
const client = createClient();

if (amountKk != null && priceRub != null) {
    const marker = gift ? PROFILE_LOT_MARKER : '·';
    const syntheticName = `${Math.round(amountKk)}КК ${marker} МОМЕНТАЛЬНО ${marker} БОНУС`;
    const completed = await resolveCompletedItemForOrder(client, {
        amountKk,
        itemPriceRub: priceRub,
        itemName: syntheticName,
    });
    if (!completed?.id) {
        console.error('[test-publish] лот не найден в completed-list');
        process.exit(1);
    }
    itemId = completed.id;
    slug = completed.slug;
    itemName = completed.name;
    priceRub = discountedPriceRub(completed);
    console.log(
        `[test-publish] completed ${amountKk}kk ₽${priceRub}${gift ? ' 🎁' : ''}\n` +
            `  id=${itemId}\n` +
            `  slug=${slug}\n` +
            `  name=${itemName}\n` +
            `  status=${completed.status} mayBePublished=${completed.mayBePublished}`,
    );
}

if (!slug && itemId) {
    slug = guessItemSlug({ itemId, itemName });
    if (slug) {
        console.log(`[test-publish] slug угадан: ${slug}`);
    }
}

let itemMeta = null;
if (slug) {
    const data = await client.itemBySlug(slug);
    itemMeta = data?.item;
    if (!itemMeta?.id) {
        console.error(`[test-publish] лот не найден: ${slug}`);
        process.exit(1);
    }
    itemId = itemMeta.id;
    priceRub = discountedPriceRub(itemMeta);
    console.log(
        `[test-publish] slug=${slug}\n` +
            `  id=${itemId}\n` +
            `  name=${itemMeta.name}\n` +
            `  status=${itemMeta.status} mayBePublished=${itemMeta.mayBePublished}\n` +
            `  price=${priceRub} rawPrice=${itemMeta.rawPrice ?? '?'}`,
    );
}

const profileLot = isMarkedProfileLot(itemMeta?.name ?? itemName);

await publishItemOnPlayerok(client, itemId, priceRub, { profileLot, slug });
console.log('[test-publish] готово');
