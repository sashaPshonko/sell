/**
 * Поиск проданного лота в completed-list для перевыставления.
 * Совпадение: itemId (приоритет) или kk + цена + 🎁/· маркер.
 */
import {
    isCurrencyKkLot,
    parseAmountKk,
    discountedPriceRub,
    guessItemSlug,
} from '../parse.mjs';
import { isMarkedProfileLot, isSearchPremiumLot } from './profile-upsell.mjs';

const PAGE_SIZE = 16;
const MAX_PAGES = Number(process.env.COMPLETED_LIST_MAX_PAGES || 20);
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

function lotMarkerLabel(itemName) {
    if (isMarkedProfileLot(itemName)) return '🎁';
    if (isSearchPremiumLot(itemName)) return '·';
    return '?';
}

function itemIdTail(itemId) {
    if (!itemId) return null;
    const tail = String(itemId).split('-').pop();
    return tail && tail.length >= 8 ? tail : null;
}

function itemMatchesOrder(item, order) {
    const name = item?.name;
    if (!name || !isCurrencyKkLot(name)) return false;

    // Точное совпадение проданного лота — главный путь для премиум (·).
    if (order?.itemId && item?.id === order.itemId) return true;

    const kk = parseAmountKk(name);
    const wantKk = orderKk(order);
    if (kk == null || wantKk == null || Math.round(kk) !== wantKk) return false;

    // · и 🎁 не путаем: точка = премка, подарок = без премки. Ничто ни во что не превращается.
    const wantProfile = isMarkedProfileLot(order?.itemName);
    const isProfile = isMarkedProfileLot(name);
    if (wantProfile !== isProfile) return false;

    const wantSearch = isSearchPremiumLot(order?.itemName);
    const isSearch = isSearchPremiumLot(name);
    if (wantSearch !== isSearch) return false;

    const price = discountedPriceRub(item);
    const wantPrice = orderPriceRub(order);
    if (!wantProfile && wantPrice != null && price != null && price !== wantPrice) {
        return false;
    }

    return true;
}

function scoreItem(item, order) {
    let score = 0;
    if (order?.itemId && item?.id === order.itemId) score += 1000;
    const tail = itemIdTail(order?.itemId);
    if (tail && item?.slug?.startsWith(`${tail}-`)) score += 500;
    if (item?.status === 'SOLD') score += 50;
    if (item?.mayBePublished === true) score += 30;
    if (item?.slug) score += 5;
    const price = discountedPriceRub(item);
    const wantPrice = orderPriceRub(order);
    if (wantPrice != null && price === wantPrice) score += 20;
    return score;
}

async function resolveSeller(client) {
    let userId = process.env.PLAYEROK_USER_ID?.trim() || null;
    let username = process.env.PLAYEROK_USERNAME?.trim() || null;
    if (!userId && typeof client.viewer === 'function') {
        const v = await client.viewer();
        userId = v?.viewer?.id || null;
        username = username || v?.viewer?.username || null;
    }
    return { userId, username };
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
    console.log(`[sell] completed-list: ${all.length} лотов в кэше (до ${MAX_PAGES} стр.)`);
    return all;
}

/** Карточка лота по slug — обходит лимит пагинации completed-list. */
async function resolveItemBySlug(client, slug) {
    if (!slug || typeof client?.itemBySlug !== 'function') return null;
    try {
        const data = await client.itemBySlug(slug);
        const item = data?.item;
        if (!item?.id) return null;
        // Не помечаем alreadyListed здесь: живой лот того же kk — донор
        // для клона, а не сигнал «перевыставлять не нужно».
        return item;
    } catch {
        return null;
    }
}

export async function findCompletedItemById(client, itemId) {
    if (!itemId || !client?.sellerCompletedItems) return null;
    const { userId, username } = await resolveSeller(client);
    if (!userId) return null;
    const items = await fetchAllCompletedItems(client, userId, username);
    return items.find((item) => item?.id === itemId) || null;
}

/**
 * @returns {Promise<{ id, slug, name, price, rawPrice, status, mayBePublished } | null>}
 */
export async function resolveCompletedItemForOrder(client, order) {
    if (!client?.sellerCompletedItems || !order) return null;

    const kk = orderKk(order);
    const price = orderPriceRub(order);
    // kk нужен для fuzzy; по itemId ищем даже без цены (ITEM_PAID часто без price).
    if (!kk && !order.itemId) return null;

    const { userId, username } = await resolveSeller(client);
    if (!userId) return null;

    const items = await fetchAllCompletedItems(client, userId, username);

    if (order.itemId) {
        const exact = items.find((item) => item?.id === order.itemId);
        if (exact) {
            console.log(
                `[sell] completed by itemId: ${order.itemId} → ${exact.slug || '?'} ` +
                    `${lotMarkerLabel(exact.name)} status=${exact.status || '?'}`,
            );
            return exact;
        }

        const slugEarly = order.itemSlug || guessItemSlug(order);
        if (slugEarly) {
            const bySlugApi = await resolveItemBySlug(client, slugEarly);
            if (bySlugApi) return logItemBySlugHit(slugEarly, bySlugApi);
        }
    }

    const slug = order.itemSlug || guessItemSlug(order);
    if (slug) {
        const bySlug = items.find((item) => item?.slug === slug);
        if (bySlug) {
            console.log(
                `[sell] completed by slug: ${slug} → ${bySlug.id?.slice(0, 8) || '?'}… ` +
                    `status=${bySlug.status || '?'}`,
            );
            return bySlug;
        }

        const tail = itemIdTail(order.itemId);
        if (tail) {
            const byTail = items.find((item) => item?.slug?.startsWith(`${tail}-`));
            if (byTail) {
                console.log(
                    `[sell] completed by slug-tail: ${tail} → ${byTail.slug || '?'} ` +
                        `status=${byTail.status || '?'}`,
                );
                return byTail;
            }
        }

        const bySlugApi = await resolveItemBySlug(client, slug);
        if (bySlugApi) return logItemBySlugHit(slug, bySlugApi);
    }

    if (!kk) {
        console.warn(
            `[sell] completed-list: нет kk для fuzzy ` +
                `(itemId=${order.itemId || '—'} slug=${slug || '—'})`,
        );
        if (slug) {
            const bySlugApi = await resolveItemBySlug(client, slug);
            if (bySlugApi) return logItemBySlugHit(slug, bySlugApi);
        }
        return null;
    }

    const candidates = items.filter((item) => itemMatchesOrder(item, order));
    if (!candidates.length) {
        console.warn(
            `[sell] completed-list: нет лота ${kk}kk ₽${price ?? '?'} ${lotMarkerLabel(order.itemName)}`,
        );
        if (slug) {
            const bySlugApi = await resolveItemBySlug(client, slug);
            if (bySlugApi) return logItemBySlugHit(slug, bySlugApi);
        }
        return null;
    }

    candidates.sort((a, b) => scoreItem(b, order) - scoreItem(a, order));
    const best = candidates[0];
    console.log(
        `[sell] completed match: ${Math.round(kk)}kk ₽${price ?? '?'} ${lotMarkerLabel(order.itemName)} → ` +
            `${best.slug || best.id} status=${best.status || '?'} ` +
            `mayBePublished=${best.mayBePublished ?? '?'}`,
    );
    return best;
}

function logItemBySlugHit(slug, item) {
    if (item.alreadyListed) {
        console.log(`[sell] completed by itemBySlug: ${slug} — уже APPROVED без buyer`);
    } else {
        console.log(
            `[sell] completed by itemBySlug: ${slug} → ${item.id.slice(0, 8)}… ` +
                `status=${item.status || '?'}`,
        );
    }
    return item;
}
