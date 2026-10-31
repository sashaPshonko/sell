import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'purchases.json');
const KEEP_MS = 90 * 24 * 3600 * 1000;
const MAX_ROWS = 4000;

function mskParts(ms) {
    const t = new Date(ms + 3 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return {
        hourMsk: t.getUTCHours(),
        msk: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`,
    };
}

function empty() {
    return { byHourMsk: Array(24).fill(0), purchases: [] };
}

function load() {
    try {
        const raw = JSON.parse(readFileSync(FILE, 'utf8'));
        if (!raw || typeof raw !== 'object') return empty();
        return {
            byHourMsk: Array(24).fill(0),
            purchases: Array.isArray(raw.purchases) ? raw.purchases : [],
        };
    } catch {
        return empty();
    }
}

function recount(data) {
    const hours = Array(24).fill(0);
    for (const p of data.purchases) {
        if (p.kind && p.kind !== 'paid') continue;
        const h = Number(p.hourMsk);
        if (h >= 0 && h < 24) hours[h] += 1;
    }
    data.byHourMsk = hours;
}

function save(data) {
    mkdirSync(dirname(FILE), { recursive: true });
    recount(data);
    writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`);
}

/** Оплата на PlayerOK или факт выдачи — для подкрутки окон смен. */
export function recordPurchase(row) {
    const atMs = Number(row.atMs) || Date.now();
    const { hourMsk, msk } = mskParts(atMs);
    const data = load();
    const cut = Date.now() - KEEP_MS;
    data.purchases = data.purchases.filter((p) => Number(p.atMs) >= cut);
    const kind = row.kind || 'paid';
    const orderId = row.orderId || '';
    if (
        orderId
        && data.purchases.some((p) => p.orderId === orderId && p.kind === kind)
    ) {
        return;
    }
    data.purchases.push({
        msk,
        atMs,
        hourMsk,
        kind,
        orderId,
        amountKk: row.amountKk ?? null,
        buyer: row.buyer || '',
        nick: row.nick || '',
    });
    if (data.purchases.length > MAX_ROWS) {
        data.purchases = data.purchases.slice(-MAX_ROWS);
    }
    save(data);
}
