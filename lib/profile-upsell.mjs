/**
 * Профильный upsell: тот же ₽, больше kk.
 *
 * Премка (поиск):  100КК · МОМЕНТАЛЬНО · БОНУС
 * Профиль (без премки): 105КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС  — 🎁 вместо ·
 */
import { readFile } from 'fs/promises';
import {
    isCurrencyKkLot,
    parseAmountKk,
    discountedPriceRub,
    listingBuyerPriceRub,
    listingRawPriceRub,
    listingHasDiscount,
} from '../parse.mjs';

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

/**
 * Уже была успешная выдача в игру этому buyerId.
 * Первая покупка → false: не делаем refund (отпугивает), выдаём + ссылку после delivery.
 * Считаем только gameDeliveryAt — playerokMarkedAt / completed без выдачи дают ложных «повторников».
 */
export function buyerHasPriorSuccessfulDelivery(state, buyerId, excludeOrderId = null) {
    if (!buyerId || !state?.orders) return false;
    for (const o of Object.values(state.orders)) {
        if (!o || o.buyerId !== buyerId) continue;
        if (excludeOrderId && (o.orderId === excludeOrderId || o.dealId === excludeOrderId)) {
            continue;
        }
        if (o.cancelReason === 'profile_upsell_refund') continue;
        if (o.gameDeliveryAt) return true;
    }
    return false;
}

/** Лот в поиске с платной премкой (· в названии, без 🎁). */
export function isSearchPremiumLot(itemName) {
    if (!itemName || isMarkedProfileLot(itemName)) return false;
    return itemName.includes('·');
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
 * 2) в названии есть 🎁
 * 3) kk строго больше, чем в купленном лоте
 * 4) цена 🎁 для покупателя == цене заказа
 *    (скидка есть → price; нет → полная price/rawPrice)
 * 5) из подходящих — минимальный kk
 *
 * Цену 🎁 уточняем через itemBySlug (operationName=item).
 */
function slugFromProductUrl(url) {
    const m = String(url || '').match(/\/products\/([^/?#]+)/);
    return m?.[1] || null;
}

function giftCandidatesFromList(items, order) {
    const baseKk = Number(order.amountKk);
    if (!baseKk || baseKk <= 0) return [];

    const out = [];
    for (const item of items) {
        const name = item?.name;
        if (!name || !isCurrencyKkLot(name)) continue;
        if (!name.includes(PROFILE_LOT_MARKER)) continue;
        const kk = parseAmountKk(name);
        if (kk == null || kk <= baseKk) continue;
        if (!item.slug) continue;
        out.push({ item, kk, listPrice: discountedPriceRub(item) });
    }
    out.sort((a, b) => a.kk - b.kk || String(a.item.id).localeCompare(String(b.item.id)));
    return out;
}

/**
 * Цена с карточки лота (item query).
 * Есть скидка → price; нет → полная (price === rawPrice).
 */
async function fetchListingPriceBySlug(client, slug) {
    if (!client?.itemBySlug || !slug) return null;
    try {
        const data = await client.itemBySlug(slug);
        const item = data?.item ?? data;
        const priceRub = listingBuyerPriceRub(item);
        if (priceRub == null || priceRub <= 0) return null;
        return {
            priceRub,
            rawPriceRub: listingRawPriceRub(item),
            hasDiscount: listingHasDiscount(item),
            item,
        };
    } catch (e) {
        console.warn(`[sell] profile-upsell item ${slug}: ${e.message}`);
        return null;
    }
}

async function pickUpsellItem(client, items, order) {
    const baseKk = Number(order.amountKk);
    const orderPrice =
        order.itemPriceRub != null ? Math.round(Number(order.itemPriceRub)) : null;

    if (!baseKk || baseKk <= 0) return null;
    if (orderPrice == null || orderPrice <= 0) return null;

    const candidates = giftCandidatesFromList(items, order);
    if (!candidates.length) return null;

    // В списке уже та же ₽ — уточняем карточкой item (curl). Чужую цену не трогаем.
    const ranked = candidates.filter(
        (c) => c.listPrice == null || c.listPrice === orderPrice,
    );
    if (!ranked.length) return null;

    for (const c of ranked) {
        const verified = await fetchListingPriceBySlug(client, c.item.slug);
        if (!verified) continue;
        if (verified.priceRub !== orderPrice) {
            console.log(
                `[sell] profile-upsell skip ${c.item.slug}: card ${verified.priceRub}₽` +
                    `${verified.hasDiscount ? ` (raw ${verified.rawPriceRub})` : ' (без скидки)'}` +
                    ` ≠ заказ ${orderPrice}₽`,
            );
            continue;
        }

        const url = productUrl(c.item.slug);
        if (!url) continue;

        console.log(
            `[sell] profile-upsell match ${c.kk}kk @${verified.priceRub}₽` +
                `${verified.hasDiscount ? ` скидка с ${verified.rawPriceRub}` : ' без скидки'}` +
                ` ← заказ ${baseKk}kk @${orderPrice}₽`,
        );

        return {
            url,
            kk: c.kk,
            emoji: PROFILE_LOT_MARKER,
            baseKk,
            priceRub: verified.priceRub,
            rawPriceRub: verified.rawPriceRub,
            hasDiscount: verified.hasDiscount,
            orderPriceRub: orderPrice,
            itemId: c.item.id,
            itemName: c.item.name,
            slug: c.item.slug,
        };
    }

    return null;
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
            const match = await pickUpsellItem(client, items, order);
            if (match?.url) return match;
        } catch (e) {
            console.warn(`[sell] profile-upsell items: ${e.message}`);
        }
    }

    const manual = manualLookup(await loadManualConfig(), order);
    if (manual?.url && !manual.kk && manual.baseKk) {
        manual.kk = Math.round(Number(manual.baseKk) + KK_BONUS_GUESS);
    }
    if (!manual?.url) return null;

    // manual тоже через карточку item — не слать ссылку дороже заказа
    const orderPrice =
        order.itemPriceRub != null ? Math.round(Number(order.itemPriceRub)) : null;
    if (orderPrice == null || orderPrice <= 0) return null;

    const slug = slugFromProductUrl(manual.url) || manual.slug;
    const verified = await fetchListingPriceBySlug(client, slug);
    if (!verified || verified.priceRub !== orderPrice) {
        console.warn(
            `[sell] profile-upsell manual skip ${slug || '?'}: ` +
                `card ${verified?.priceRub ?? '?'}₽ ≠ заказ ${orderPrice}₽`,
        );
        return null;
    }
    return {
        ...manual,
        priceRub: verified.priceRub,
        rawPriceRub: verified.rawPriceRub,
        hasDiscount: verified.hasDiscount,
        orderPriceRub: orderPrice,
        slug,
    };
}

/**
 * Самый большой 🎁-лот ≤ maxKk (без премки).
 * @param {object} [opts]
 * @param {boolean} [opts.matchOrderPrice=true] — для апселла после оплаты (та же ₽).
 *   false — для «мало валюты»: любой 🎁, лишь бы влез по кк.
 */
export async function resolveGiftLotUpToKk(
    client,
    order,
    sellerUserId,
    sellerUsername,
    maxKk,
    opts = {},
) {
    const matchOrderPrice = opts.matchOrderPrice !== false;
    const cap = Math.round(Number(maxKk) || 0);
    if (!client?.sellerItems || !sellerUserId || cap <= 0) return null;

    let items;
    try {
        items = await fetchSellerItemsCached(client, sellerUserId, sellerUsername);
    } catch (e) {
        console.warn(`[sell] gift≤kk items: ${e.message}`);
        return null;
    }

    const orderPrice =
        order?.itemPriceRub != null ? Math.round(Number(order.itemPriceRub)) : null;

    const candidates = [];
    for (const item of items) {
        const name = item?.name;
        if (!name || !isCurrencyKkLot(name)) continue;
        if (!name.includes(PROFILE_LOT_MARKER)) continue;
        const kk = parseAmountKk(name);
        if (kk == null || kk <= 0 || kk > cap) continue;
        if (!item.slug) continue;
        const listPrice = discountedPriceRub(item);
        if (
            matchOrderPrice &&
            orderPrice != null &&
            listPrice != null &&
            listPrice > orderPrice
        ) {
            continue;
        }
        candidates.push({ item, kk, listPrice });
    }
    if (!candidates.length) return null;

    // Главное — max кк; цена только tie-break.
    candidates.sort((a, b) => {
        if (b.kk !== a.kk) return b.kk - a.kk;
        if (matchOrderPrice) {
            const aSame = orderPrice != null && a.listPrice === orderPrice ? 1 : 0;
            const bSame = orderPrice != null && b.listPrice === orderPrice ? 1 : 0;
            if (aSame !== bSame) return bSame - aSame;
        }
        const aRub = a.listPrice ?? Number.POSITIVE_INFINITY;
        const bRub = b.listPrice ?? Number.POSITIVE_INFINITY;
        return aRub - bRub;
    });

    for (const c of candidates.slice(0, 12)) {
        const verified = await fetchListingPriceBySlug(client, c.item.slug);
        if (!verified) continue;
        if (matchOrderPrice && orderPrice != null && verified.priceRub > orderPrice) {
            continue;
        }
        const url = productUrl(c.item.slug);
        if (!url) continue;
        return {
            url,
            kk: c.kk,
            emoji: PROFILE_LOT_MARKER,
            priceRub: verified.priceRub,
            baseKk: Math.round(Number(order?.amountKk) || 0),
        };
    }
    return null;
}

export function invalidateProfileUpsellCache() {
    itemsCache = { at: 0, userId: null, items: [] };
}
