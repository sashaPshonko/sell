#!/usr/bin/env node
/**
 * Статус заказа: state.json + audit.jsonl (не зависит от sell.log).
 * node scripts/order-status.mjs 1f159235
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const needle = process.argv[2]?.trim();
if (!needle) {
    console.error('Использование: node scripts/order-status.mjs <orderId или префикс>');
    process.exit(1);
}

const statePath = process.env.STATE_FILE || './state.json';
const auditPath = process.env.AUDIT_FILE || './audit.jsonl';

if (existsSync(statePath)) {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const orders = Object.values(state.orders || {}).filter((o) =>
        String(o.orderId || o.dealId || '').includes(needle),
    );
    if (!orders.length) {
        console.log(`state.json: заказов с «${needle}» нет`);
    } else {
        for (const o of orders) {
            console.log('--- state ---');
            console.log(JSON.stringify(o, null, 2));
        }
    }
} else {
    console.log(`нет ${statePath}`);
}

if (existsSync(auditPath)) {
    const raw = await readFile(auditPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const hits = lines.filter((l) => l.includes(needle));
    if (!hits.length) {
        console.log(`audit.jsonl: событий с «${needle}» нет`);
    } else {
        console.log(`--- audit (${hits.length}) ---`);
        for (const line of hits.slice(-30)) {
            console.log(line);
        }
    }
} else {
    console.log(`нет ${auditPath} (появится после git pull и новых заказов)`);
}
