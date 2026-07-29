import { loadEnv } from '../lib/env.mjs';
import { createClient } from '../playerok-client.mjs';
import { readFileSync } from 'fs';

loadEnv();
const client = createClient();
const s = JSON.parse(readFileSync('./state.json', 'utf8'));
const recent = Object.values(s.orders)
    .filter((o) => o.itemSlug && o.phase === 'completed')
    .sort((a, b) => (b.paidAt || '').localeCompare(a.paidAt || ''))
    .slice(0, 10);

for (const o of recent) {
    try {
        const data = await client.itemBySlug(o.itemSlug);
        const i = data?.item || data;
        console.log(
            (o.orderId || '').slice(0, 8),
            o.playerokStatus,
            `status=${i?.status}`,
            `buyer=${i?.buyer?.username || i?.buyer?.id || null}`,
            `mayPub=${i?.mayBePublished}`,
            `edit=${i?.editable}`,
            `paid=${(o.paidAt || '').slice(0, 16)}`,
        );
    } catch (e) {
        console.log((o.orderId || '').slice(0, 8), 'meta fail', e.message.slice(0, 100));
    }
}
