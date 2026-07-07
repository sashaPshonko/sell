/**
 * Ручной тест перевыставления.
 *
 * npm run test-publish -- <itemId> [priceRub]
 * npm run test-publish -- --slug e65e10525c98-270kk-momentalno-bonus
 */
import { loadEnv } from '../lib/env.mjs';
import { assertPlayerokAuth } from '../lib/check-auth.mjs';
import { createClient } from '../playerok-client.mjs';
import { publishItemOnPlayerok } from '../publish.mjs';
import { isMarkedProfileLot } from '../lib/profile-upsell.mjs';
import { discountedPriceRub } from '../parse.mjs';

loadEnv();

const args = process.argv.slice(2);
let itemId = null;
let priceRub = null;
let slug = null;

for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--slug' && args[i + 1]) {
        slug = args[++i].trim();
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

if (!itemId && !slug) {
    console.error('Использование:');
    console.error('  npm run test-publish -- <itemId> [priceRub]');
    console.error('  npm run test-publish -- --slug <slug>');
    process.exit(1);
}

await assertPlayerokAuth();
const client = createClient();

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

const profileLot = isMarkedProfileLot(itemMeta?.name);

await publishItemOnPlayerok(client, itemId, priceRub, { profileLot, slug });
console.log('[test-publish] готово');
