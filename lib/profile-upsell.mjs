/**
 * Профильный upsell: тот же ₽, больше kk.
 *
 * Премка (поиск):  100КК · МОМЕНТАЛЬНО · БОНУС
 * Профиль (без премки): 105КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС  — 🎁 вместо ·
 */
import { readFile } from 'fs/promises';
import { isCurrencyKkLot, parseAmountKk } from '../parse.mjs';

/** Профильный лот — 🎁 вместо ·, без премки PlayerOK */
export const PROFILE_LOT_MARKER = '🎁';

const PRODUCT_BASE = 'https://playerok.com/products/';
const MANUAL_JSON_PATH = './profile-upsell.json';
const MANUAL_JSON_TTL_MS = 60_000;
const ITEMS_CACHE_TTL_MS = 120_000;
const ITEMS_PAGE_SIZE = 16;
const ITEMS_MAX_PAGES = 8;
const KK_BONUS_GUESS = 5;

let itemsCache = { at: 0, userId: null, items: [] };
let manualConfigCache = { at: 0, data: null };

export function profileUpsellEmoji() {
    return PROFILE_LOT_MARKER;
}

export function isMarkedProfileLot(itemName) {
    return Boolean(itemName && itemName.includes(PROFILE_LOT_MARKER));
}

function productUrl(slug) {
    if (!slug) return null;
    const s = String(slug).trim();
    if (!s) return null;
    if (s.startsWith('http')) return s;
    return `${PRODUCT_BASE}${s.replace(/^\//, '')}`;
}

function flattenItems(data) {
    const root = data?.items ?? data?.userItems ?? data;
    if (!root) return [];
    if (Array.isArray(root)) return root;
    const edges = root.edges ?? root.nodes;
    if (Array.isArray(edges)) {
        return edges.map((e) => e?.node ?? e).filter(Boolean);
    }
    return [];
}

function pageInfo(data) {
    const root = data?.items ?? data?.userItems ?? data;
    return root?.pageInfo ?? null;
}

async function loadManualConfig() {
    const now = Date.now();
    if (manualConfigCache.data && now - manualConfigCache.at < MANUAL_JSON_TTL_MS) {
        return manualConfigCache.data;
    }
    try {
        const raw = await readFile(MANUAL_JSON_PATH, 'utf8');
        manualConfigCache = { at: now, data: JSON.parse(raw) };
        return manualConfigCache.data;
    } catch {
        manualConfigCache = { at: now, data: null };
        return null;
    }
}

function manualLookup(config, order) {
    if (!config) return null;
    const emoji = config.emoji?.trim() || PROFILE_LOT_MARKER;
    const baseKey = String(Math.round(Number(order.amountKk) || 0));
    const priceKey = order.itemPriceRub != null ? String(Math.round(order.itemPriceRub)) : null;

    let entry = config.byBaseKk?.[baseKey] ?? null;
    if (!entry && priceKey) {
        entry = config.byPriceRub?.[priceKey] ?? config.byPrice?.[priceKey] ?? null;
    }
    if (!entry) return null;

    if (typeof entry === 'string') {
        return {
            url: productUrl(entry),
            kk: Math.round(Number(order.amountKk) + KK_BONUS_GUESS),
            emoji,
            baseKk: order.amountKk,
            priceRub: order.itemPriceRub,
        };
    }
    const url = productUrl(entry.url ?? entry.slug ?? entry.link);
    if (!url) return null;
    return {
        url,
        kk: entry.kk ?? null,
        emoji,
        baseKk: order.amountKk,
        priceRub: order.itemPriceRub,
    };
}

/**
 * Ищем профильный аналог купленного лота:
 * 1) название — валюта (Nkk в начале)
 * 2) в названии есть ⭐
 * 3) kk строго больше, чем в купленном лоте
 * 4) цена в ₽ совпадает с купленным (если известна)
 * 5) из подходящих — минимальный kk (ближайший «+5kk»)
 */
function pickUpsellItem(items, order) {
    const baseKk = Number(order.amountKk);
    const priceRub =
        order.itemPriceRub != null ? Math.round(Number(order.itemPriceRub)) : null;

    if (!baseKk || baseKk <= 0) return null;

    const candidates = [];
    for (const item of items) {
        const name = item?.name;
        if (!name || !isCurrencyKkLot(name)) continue;
        if (!name.includes(PROFILE_LOT_MARKER)) continue;

        const kk = parseAmountKk(name);
        if (kk == null || kk <= baseKk) continue;

        const itemPrice =
            item.price != null ? Math.round(Number(item.price)) : null;
        if (priceRub != null && itemPrice != null && itemPrice !== priceRub) {
            continue;
        }

        candidates.push({ item, kk });
    }

    if (!candidates.length) return null;

    candidates.sort((a, b) => a.kk - b.kk || String(a.item.id).localeCompare(String(b.item.id)));
    const best = candidates[0];
    const url = productUrl(best.item.slug);
    if (!url) return null;

    return {
        url,
        kk: best.kk,
        emoji: PROFILE_LOT_MARKER,
        baseKk,
        priceRub,
        itemId: best.item.id,
        itemName: best.item.name,
    };
}

async function fetchSellerItemsCached(client, sellerUserId, sellerUsername = null) {
    const now = Date.now();
    if (
        itemsCache.userId === sellerUserId &&
        itemsCache.items.length &&
        now - itemsCache.at < ITEMS_CACHE_TTL_MS
    ) {
        return itemsCache.items;
    }

    const all = [];
    let after = null;

    for (let page = 0; page < ITEMS_MAX_PAGES; page++) {
        const data = await client.sellerItems(sellerUserId, {
            first: ITEMS_PAGE_SIZE,
            after,
            username: sellerUsername,
        });
        all.push(...flattenItems(data));
        const pi = pageInfo(data);
        if (!pi?.hasNextPage || !pi.endCursor) break;
        after = pi.endCursor;
    }

    itemsCache = { at: now, userId: sellerUserId, items: all };
    console.log(`[sell] profile-upsell: ${all.length} лотов в кэше`);
    return all;
}

/**
 * @returns {Promise<{ url: string, kk: number, emoji: string, baseKk: number, priceRub?: number } | null>}
 */
export async function resolveProfileUpsell(client, order, sellerUserId, sellerUsername = null) {
    if (!order) return null;
    if (isMarkedProfileLot(order.itemName)) {
        return null;
    }

    if (client?.sellerItems && sellerUserId) {
        try {
            const items = await fetchSellerItemsCached(
                client,
                sellerUserId,
                sellerUsername,
            );
            const match = pickUpsellItem(items, order);
            if (match?.url) return match;
        } catch (e) {
            console.warn(`[sell] profile-upsell items: ${e.message}`);
        }
    }

    const manual = manualLookup(await loadManualConfig(), order);
    if (manual?.url && !manual.kk && manual.baseKk) {
        manual.kk = Math.round(Number(manual.baseKk) + KK_BONUS_GUESS);
    }
    return manual?.url ? manual : null;
}

export function invalidateProfileUpsellCache() {
    itemsCache = { at: 0, userId: null, items: [] };
}
