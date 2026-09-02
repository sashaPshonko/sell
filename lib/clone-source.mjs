/**
 * Откуда брать карточку для createItem после продажи.
 * Угаданный slug часто 404, а «уже APPROVED» на чужом лоте того же kk
 * раньше глушило перевыставление — витрина оставалась дырявой.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { parseAmountKk } from '../parse.mjs';
import { isMarkedProfileLot } from './profile-upsell.mjs';

const TEMPLATE_PATH = process.env.CLONE_TEMPLATE_FILE || './clone-templates.json';

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

export function cloneTemplateKey(itemName, amountKk = null) {
    const kk = amountKk ?? parseAmountKk(itemName);
    const kind = isMarkedProfileLot(itemName) ? 'gift' : 'search';
    return `${Math.round(Number(kk) || 0)}:${kind}`;
}

export function pickCloneShape(item) {
    if (!item || typeof item !== 'object') return item;
    const category = item.category || item.gameCategory || item.category;
    const obtainingType = item.obtainingType || item.obtainingType;
    const dataFields = item.dataFields || item.dataFields || [];
    const attachments = item.attachments || item.attachments || [];
    return {
        ...item,
        category,
        obtainingType,
        dataFields,
        attachments,
        isAttachmentsForbidden:
            item.isAttachmentsForbidden ?? item.isAttachmentsForbidden,
    };
}

export function isLiveOnSale(item) {
    if (!item || item.status !== 'APPROVED') return false;
    return !item.buyer?.id && !item.buyer?.username;
}

export function itemHasCloneFields(item) {
    const shaped = pickCloneShape(item);
    return Boolean(shaped?.category?.id && shaped?.obtainingType?.id);
}

export function mergeCloneSource(primary, donor) {
    const a = pickCloneShape(primary);
    const b = pickCloneShape(donor);
    if (itemHasCloneFields(a)) return a;
    if (!b) return a;
    return pickCloneShape({
        ...b,
        ...a,
        name: a?.name || b.name,
        description: a?.description || b.description,
        price: a?.price ?? b.price,
        rawPrice: a?.rawPrice ?? b.rawPrice,
        attributes: a?.attributes || b.attributes,
        category: a?.category || b.category,
        obtainingType: a?.obtainingType || b.obtainingType,
        dataFields:
            Array.isArray(a?.dataFields) && a.dataFields.length
                ? a.dataFields
                : b.dataFields,
        attachments:
            Array.isArray(a?.attachments) && a.attachments.length
                ? a.attachments
                : b.attachments,
        isAttachmentsForbidden:
            a?.isAttachmentsForbidden ?? b.isAttachmentsForbidden,
    });
}

function loadTemplates() {
    try {
        return JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
    } catch {
        return {};
    }
}

export function saveCloneTemplate(item) {
    const shaped = pickCloneShape(item);
    if (!itemHasCloneFields(shaped) || !shaped.name) return;
    const key = cloneTemplateKey(shaped.name);
    if (key.startsWith('0:')) return;
    const all = loadTemplates();
    const slim = {
        name: shaped.name,
        description: shaped.description || '',
        price: shaped.price,
        rawPrice: shaped.rawPrice,
        attributes: shaped.attributes || {},
        category: shaped.category,
        obtainingType: shaped.obtainingType,
        dataFields: shaped.dataFields || [],
        attachments: (shaped.attachments || [])
            .filter((x) => x?.url)
            .map((x) => ({ url: x.url })),
        isAttachmentsForbidden: Boolean(shaped.isAttachmentsForbidden),
        savedAt: new Date().toISOString(),
    };
    all[key] = slim;
    mkdirSync(dirname(TEMPLATE_PATH) === '.' ? '.' : dirname(TEMPLATE_PATH), { recursive: true });
    writeFileSync(TEMPLATE_PATH, JSON.stringify(all, null, 2));
}

export function loadCloneTemplate(itemName, amountKk = null) {
    const key = cloneTemplateKey(itemName, amountKk);
    const row = loadTemplates()[key];
    return row ? pickCloneShape(row) : null;
}

function sameProduct(item, order) {
    const name = item?.name || '';
    const kk = parseAmountKk(name);
    const want = order?.amountKk ?? parseAmountKk(order?.itemName);
    if (kk == null || want == null || Math.round(kk) !== Math.round(want)) return false;
    return isMarkedProfileLot(name) === isMarkedProfileLot(order?.itemName);
}

async function loadBySlug(client, slug) {
    if (!slug || typeof client?.itemBySlug !== 'function') return null;
    try {
        const data = await client.itemBySlug(slug);
        return pickCloneShape(data?.item || null);
    } catch (e) {
        console.warn(`[sell] itemBySlug ${slug}: ${e.message || e}`);
        return null;
    }
}

async function fetchSellerPages(client, method, userId, username, maxPages = 4) {
    if (!userId || typeof client?.[method] !== 'function') return [];
    const all = [];
    let after = null;
    for (let page = 0; page < maxPages; page++) {
        const data = await client[method](userId, {
            first: 16,
            after,
            username,
        });
        all.push(...flattenItems(data));
        const pi = pageInfo(data);
        if (!pi?.hasNextPage || !pi.endCursor) break;
        after = pi.endCursor;
    }
    return all;
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

/**
 * Полная карточка для createItem. Не считает чужой живой лот «уже выставленным».
 * @returns {Promise<{ item: object, alreadyListed: boolean }>}
 */
export async function resolveCloneSource(client, order, completed = null) {
    const soldId = order?.itemId || completed?.id || null;
    const slugs = [];
    const addSlug = (s) => {
        if (s && !slugs.includes(s)) slugs.push(s);
    };
    addSlug(order?.itemSlug);
    addSlug(completed?.slug);

    let soldCard = null;
    for (const slug of slugs) {
        const item = await loadBySlug(client, slug);
        if (!item?.id) continue;
        if (soldId && item.id === soldId) {
            soldCard = item;
            if (
                item.status === 'APPROVED' &&
                !item.buyer?.id &&
                !item.buyer?.username
            ) {
                return { item, alreadyListed: true };
            }
            if (itemHasCloneFields(item)) {
                saveCloneTemplate(item);
                return { item, alreadyListed: false };
            }
            continue;
        }
        // чужой лот — только донор полей, не «уже выставлено»
        if (itemHasCloneFields(item) && !soldCard) {
            soldCard = mergeCloneSource(
                {
                    name: order?.itemName || item.name,
                    price: order?.itemPriceRub ?? item.price,
                    rawPrice: item.rawPrice,
                    slug: completed?.slug || order?.itemSlug,
                    id: soldId,
                },
                item,
            );
        }
    }

    if (completed?.id) {
        soldCard = mergeCloneSource(
            { ...completed, name: completed.name || order?.itemName },
            soldCard,
        );
        if (itemHasCloneFields(soldCard)) {
            saveCloneTemplate(soldCard);
            return { item: soldCard, alreadyListed: false };
        }
    }

    const { userId, username } = await resolveSeller(client);
    const live = await fetchSellerPages(client, 'sellerItems', userId, username, 3);
    const liveSame = live.find((it) => sameProduct(it, order) && isLiveOnSale(it));
    if (liveSame) {
        console.log(
            `[sell] clone-source: уже висит ${liveSame.slug || liveSame.id} — клон не нужен`,
        );
        return { item: pickCloneShape(liveSame), alreadyListed: true };
    }
    const donorLive = live.find((it) => sameProduct(it, order) && it?.slug);
    if (donorLive?.slug) {
        const full = (await loadBySlug(client, donorLive.slug)) || pickCloneShape(donorLive);
        soldCard = mergeCloneSource(
            {
                ...(soldCard || {}),
                name: order?.itemName || full?.name,
                price: order?.itemPriceRub ?? soldCard?.price ?? full?.price,
            },
            full,
        );
        if (itemHasCloneFields(soldCard)) {
            saveCloneTemplate(full);
            return { item: soldCard, alreadyListed: false };
        }
    }

    const tmpl = loadCloneTemplate(order?.itemName, order?.amountKk);
    if (tmpl) {
        soldCard = mergeCloneSource(
            {
                name: order?.itemName || tmpl.name,
                price: order?.itemPriceRub ?? tmpl.price,
                rawPrice: tmpl.rawPrice,
                id: soldId,
            },
            tmpl,
        );
        if (itemHasCloneFields(soldCard)) {
            console.log(
                `[sell] clone-source: шаблон ${cloneTemplateKey(order?.itemName, order?.amountKk)}`,
            );
            return { item: soldCard, alreadyListed: false };
        }
    }

    if (itemHasCloneFields(soldCard)) {
        return { item: soldCard, alreadyListed: false };
    }
    throw new Error(
        `нет карточки лота (slug=${slugs[0] || '—'}) — createItem не из чего клонировать`,
    );
}
