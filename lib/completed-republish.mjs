/**
 * Поиск проданного лота в completed-list для перевыставления.
 * Совпадение: kk + цена (price) + 🎁/· маркер.
 */
import {
    isCurrencyKkLot,
    parseAmountKk,
    discountedPriceRub,
} from '../parse.mjs';
import { isMarkedProfileLot } from './profile-upsell.mjs';

const PAGE_SIZE = 16;
const MAX_PAGES = 8;
const CACHE_TTL_MS = 60_000;

let cache = { at: 0, userId: null, items: [] };

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

function orderKk(order) {
    const kk = order?.amountKk ?? parseAmountKk(order?.itemName);
    return kk != null ? Math.round(Number(kk)) : null;
}

function orderPriceRub(order) {
    if (order?.itemPriceRub == null) return null;
    return Math.round(Number(order.itemPriceRub));
}

function itemMatchesOrder(item, order) {
    const name = item?.name;
    if (!name || !isCurrencyKkLot(name)) return false;

    const kk = parseAmountKk(name);
    const wantKk = orderKk(order);
    if (kk == null || wantKk == null || Math.round(kk) !== wantKk) return false;

    const price = discountedPriceRub(item);
    const wantPrice = orderPriceRub(order);
    if (wantPrice != null && price != null && price !== wantPrice) return false;

    const wantProfile = isMarkedProfileLot(order?.itemName);
    const isProfile = isMarkedProfileLot(name);
    return wantProfile === isProfile;
}

function scoreItem(item, order) {
    let score = 0;
    if (order?.itemId && item?.id === order.itemId) score += 100;
    if (item?.status === 'SOLD') score += 50;
    if (item?.mayBePublished === true) score += 30;
    if (item?.slug) score += 5;
    return score;
}

async function fetchAllCompletedItems(client, userId, username = null) {
    const now = Date.now();
    if (
        cache.userId === userId &&
        cache.items.length &&
        now - cache.at < CACHE_TTL_MS
    ) {
        return cache.items;
    }

    const all = [];
    let after = null;

    for (let page = 0; page < MAX_PAGES; page++) {
        const data = await client.sellerCompletedItems(userId, {
            first: PAGE_SIZE,
            after,
            username,
        });
        all.push(...flattenItems(data));
        const pi = pageInfo(data);
        if (!pi?.hasNextPage || !pi.endCursor) break;
        after = pi.endCursor;
    }

    cache = { at: now, userId, items: all };
    console.log(`[sell] completed-list: ${all.length} лотов в кэше`);
    return all;
}

/**
 * @returns {Promise<{ id, slug, name, price, rawPrice, status, mayBePublished } | null>}
 */
export async function resolveCompletedItemForOrder(client, order) {
    if (!client?.sellerCompletedItems || !order) return null;

    const kk = orderKk(order);
    const price = orderPriceRub(order);
    if (!kk || price == null) return null;

    let userId = process.env.PLAYEROK_USER_ID?.trim() || null;
    let username = process.env.PLAYEROK_USERNAME?.trim() || null;
    if (!userId && typeof client.viewer === 'function') {
        const v = await client.viewer();
        userId = v?.viewer?.id || null;
        username = username || v?.viewer?.username || null;
    }
    if (!userId) return null;

    const items = await fetchAllCompletedItems(client, userId, username);
    const candidates = items.filter((item) => itemMatchesOrder(item, order));
    if (!candidates.length) {
        const marker = isMarkedProfileLot(order.itemName) ? '🎁' : '·';
        console.warn(
            `[sell] completed-list: нет лота ${kk}kk ₽${price} ${marker}`,
        );
        return null;
    }

    candidates.sort((a, b) => scoreItem(b, order) - scoreItem(a, order));
    const best = candidates[0];
    const marker = isMarkedProfileLot(best.name) ? '🎁' : '·';
    console.log(
        `[sell] completed match: ${Math.round(kk)}kk ₽${price} ${marker} → ` +
            `${best.slug || best.id} status=${best.status || '?'} ` +
            `mayBePublished=${best.mayBePublished ?? '?'}`,
    );
    return best;
}
