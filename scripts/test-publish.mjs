/**
 * Ручной тест перевыставления.
 * npm run test-publish -- <itemId> [priceRub]
 *
 * Пример:
 * npm run test-publish -- 1f164322-27c7-6440-49f8-0ac42a7d895b 299
 */
import { loadEnv } from '../lib/env.mjs';
import { assertPlayerokAuth } from '../lib/check-auth.mjs';
import { createClient } from '../playerok-client.mjs';
import { publishItemOnPlayerok } from '../publish.mjs';

loadEnv();

const itemId = process.argv[2]?.trim();
const priceRub = process.argv[3] != null ? Number(process.argv[3]) : 299;

if (!itemId) {
    console.error('Использование: npm run test-publish -- <itemId> [priceRub]');
    process.exit(1);
}

await assertPlayerokAuth();
const client = createClient();
await publishItemOnPlayerok(client, itemId, priceRub);
console.log('[test-publish] готово');
