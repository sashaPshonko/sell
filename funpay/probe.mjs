/**
 * Проверка клиента FunPay на живом аккаунте, только чтение (ничего не пишет и не покупает):
 *   node funpay/probe.mjs                 — вход, последние продажи
 *   node funpay/probe.mjs --order ID      — детали заказа + чат с покупателем
 *   node funpay/probe.mjs --order ID --dump ./dump   — сохранить сырой HTML/JSON (для правки селекторов)
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadEnv } from '../lib/env.mjs';
import { FunPayClient, parseSales } from './client.mjs';
import { computeOrderKk } from './amount.mjs';

loadEnv();
const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? process.argv[i + 1] : null;
};
const dumpDir = arg('--dump');
if (dumpDir) mkdirSync(dumpDir, { recursive: true });
const dump = (name, data) => dumpDir && writeFileSync(join(dumpDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

const c = new FunPayClient({ goldenKey: process.env.FUNPAY_GOLDEN_KEY });
const me = await c.init();
console.log(`вошли: ${me.username} (id ${me.userId}), csrf ${c.csrf.slice(0, 6)}…`);

const salesHtml = await c.request('GET', '/orders/trade');
dump('sales.html', salesHtml);
const { orders } = parseSales(salesHtml);
console.log(`\nпродаж на первой странице: ${orders.length}`);
for (const o of orders.slice(0, 8)) {
    console.log(` #${o.id} [${o.status}] ${o.buyerName}(${o.buyerId}) ${o.price} ${o.currency} — ${o.description}`);
}

const oid = arg('--order') || orders[0]?.id;
if (oid) {
    console.log(`\n── заказ #${oid} ──`);
    const html = await c.request('GET', `/orders/${oid}/`);
    dump(`order-${oid}.html`, html);
    const { parseOrderPage } = await import('./client.mjs');
    const d = parseOrderPage(html);
    console.log('параметры:', d.params);
    console.log('количество:', d.quantity, `(«${d.quantityText}»)`);
    const so = orders.find((x) => x.id === oid);
    console.log('расчёт кк:', computeOrderKk({ ...d, description: so?.description }));
    if (so?.buyerId) {
        const node = c.chatNode(so.buyerId);
        console.log(`\n── чат ${node} ──`);
        const msgs = await c.getChatHistory(node, -1);
        dump(`chat-${node}.json`, msgs.map((m) => m.raw));
        for (const m of msgs.slice(-8)) console.log(` ${m.id} [${m.system ? 'sys' : m.author}] ${m.text.replace(/\n/g, ' ⏎ ').slice(0, 140)}`);
    }
}
