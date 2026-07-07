/** Латинская k вместо кириллической «к» в «100кк» */
function normalizeItemName(itemName) {
    return String(itemName)
        .replace(/к/gi, 'k')
        .replace(/К/g, 'K')
        .trim();
}

/**
 * Лот с валютой: название начинается с числа + kk/кк (100kk, 50KK, 150кк).
 * Предметы без kk в начале — не автопродажа.
 */
export function isCurrencyKkLot(itemName) {
    if (!itemName) return false;
    const n = normalizeItemName(itemName);
    return /^\d+(?:[.,]\d+)?\s*kk\b/i.test(n);
}

/** Сколько KK: «100KK FUNTIME», «50kk», «150кк spooky» */
export function parseAmountKk(itemName) {
    if (!isCurrencyKkLot(itemName)) return null;
    const n = normalizeItemName(itemName);
    const m = n.match(/^(\d+(?:[.,]\d+)?)\s*kk\b/i);
    return m ? Number(m[1].replace(',', '.')) : null;
}

/** Цена со скидкой (price), не rawPrice. */
export function discountedPriceRub(itemOrPrice) {
    if (itemOrPrice == null) return null;
    if (typeof itemOrPrice === 'object') {
        const p = itemOrPrice.price;
        return p != null ? Math.round(Number(p)) : null;
    }
    const n = Number(itemOrPrice);
    return Number.isFinite(n) ? Math.round(n) : null;
}

export function parseServer(itemName) {
    if (!itemName) return null;
    const n = normalizeItemName(itemName);
    const m = n.match(/^\d+(?:[.,]\d+)?\s*kk\s+(\w+)/i);
    return m ? m[1].toLowerCase() : null;
}

function buildCurrencyDeal(msg) {
    if (msg.text !== '{{ITEM_PAID}}' || !msg.deal) return null;
    if (msg.deal.direction !== 'OUT') return null;

    const item = msg.deal.item;
    const name = item?.name;
    if (!isCurrencyKkLot(name)) return null;

    const amountKk = parseAmountKk(name);
    if (amountKk == null || amountKk <= 0) return null;

    return {
        dealId: msg.deal.id,
        chatId: msg.deal.chat?.id,
        status: msg.deal.status,
        buyer: msg.deal.user?.username,
        buyerId: msg.deal.user?.id,
        itemId: item?.id,
        itemName: name,
        itemPriceRub: discountedPriceRub(item),
        itemSlug: item?.slug || null,
        amountKk,
        server: parseServer(name),
        paidAt: msg.createdAt,
    };
}

const MC_NICK = /^[a-zA-Z0-9_]{3,16}$/;

export function sameUserId(a, b) {
    if (a == null || b == null) return false;
    return String(a) === String(b);
}

function sellerNickCommandText(text) {
    return /^\/nick\s+[a-zA-Z0-9_]{3,16}\b/i.test(String(text || '').trim());
}

export function isSellerNickCommand(msg, sellerUserId, sellerUsername) {
    if (!msg?.text || !sellerNickCommandText(msg.text)) return false;
    const uid = msg.user?.id;
    if (sellerUserId && sameUserId(uid, sellerUserId)) return true;
    if (
        sellerUsername
        && msg.user?.username
        && String(msg.user.username).toLowerCase() === String(sellerUsername).toLowerCase()
    ) {
        return true;
    }
    return false;
}

/** processedNick: только сообщения покупателя; /nick продавца не «съедается» на весь чат */
export function nickIntakeAlreadyKnown(msg, buyerUserId, knownMessageIds) {
    if (!knownMessageIds?.has?.(msg?.id)) return false;
    return sameUserId(msg.user?.id, buyerUserId);
}

export function isBuyerUser(msg, buyerUserId, buyerUsername = null) {
    if (!msg?.user) return false;
    if (sameUserId(msg.user?.id, buyerUserId)) return true;
    if (
        buyerUsername
        && msg.user?.username
        && String(msg.user.username).toLowerCase() === String(buyerUsername).toLowerCase()
    ) {
        return true;
    }
    return false;
}

function textTokens(text) {
    return String(text)
        .trim()
        .split(/[\s:;,，、—–\-]+/)
        .map((w) => w.replace(/^[`'\"«»\[\]()]+|[`'\"«»\[\]()]+$/g, ''))
        .filter(Boolean);
}

function textHasNikWord(text) {
    return textTokens(text).some((w) => /^ник$/iu.test(w));
}

/** Отмена заказа покупателем */
export function isCancelCommand(text) {
    return /^\/cancel\s*$/i.test(String(text || '').trim());
}

/** Банлист: только продавец в своих сообщениях в чате */
export function isBanCommand(text) {
    return /^\/ban\s*$/i.test(String(text || '').trim());
}

export function isUnbanCommand(text) {
    return /^\/unban\s*$/i.test(String(text || '').trim());
}

/** «ник Steve», «Steve ник», «ник: steve123» — только латиница 3–16 */
export function parseNickFromNikPhrase(text) {
    if (!text) return null;
    const t = text.trim();
    if (!t || t.startsWith('{{')) return null;

    if (!textHasNikWord(t)) return null;

    const tokens = textTokens(t);
    let afterNik = false;
    let beforeNik = null;
    for (const word of tokens) {
        if (/^ник$/iu.test(word)) {
            if (beforeNik && MC_NICK.test(beforeNik)) {
                return { nick: beforeNik, via: 'nik_phrase' };
            }
            afterNik = true;
            beforeNik = null;
            continue;
        }
        if (afterNik && MC_NICK.test(word)) {
            return { nick: word, via: 'nik_phrase' };
        }
        beforeNik = word;
    }
    return null;
}

/**
 * Ник из «/nick Steve», «ник Steve» или одного слова «Steve» (валидный MC-ник).
 * @param {{ allowNikPhrase?: boolean, allowBareNick?: boolean }} [opts]
 */
export function parseNickFromText(text, opts = {}) {
    if (!text) return null;
    const t = text.trim();
    if (!t || t.startsWith('{{')) return null;

    const cmd = t.match(/^\/nick\s+([a-zA-Z0-9_]{3,16})\b/i);
    if (cmd) return { nick: cmd[1], via: 'command' };

    if (opts.allowNikPhrase !== false) {
        const fromPhrase = parseNickFromNikPhrase(t);
        if (fromPhrase) return fromPhrase;
    }

    if (opts.allowBareNick !== false && !t.startsWith('/')) {
        const tokens = textTokens(t);
        if (tokens.length === 1 && MC_NICK.test(tokens[0])) {
            return { nick: tokens[0], via: 'bare' };
        }
    }
    return null;
}

/** Покупатель или продавец (/nick) задаёт ник для выдачи. */
export function isNickMessageForBuyer(msg, buyerUserId, sellerUserId = null, opts = {}) {
    if (!msg?.text || msg.deal) return false;
    const buyerUsername = opts.buyerUsername ?? null;
    if (isBuyerUser(msg, buyerUserId, buyerUsername)) return true;
    const sellerUsername = opts.sellerUsername ?? null;
    return isSellerNickCommand(msg, sellerUserId, sellerUsername);
}

/**
 * @param {{ allowNikPhrase?: boolean }} [opts]
 */
export function parseNickFromMessage(msg, buyerUserId, sellerUserId = null, opts = {}) {
    if (!isNickMessageForBuyer(msg, buyerUserId, sellerUserId, opts)) return null;
    const sellerUsername = opts.sellerUsername ?? null;
    const fromSeller = isSellerNickCommand(msg, sellerUserId, sellerUsername);
    const parseOpts = fromSeller ? { ...opts, allowNikPhrase: false } : opts;
    const parsed = parseNickFromText(msg.text, parseOpts);
    if (!parsed) return null;
    if (fromSeller) return { ...parsed, via: 'command', fromSeller: true };
    return parsed;
}

/** Покупатель явно пытался указать ник, но формат неверный (не любой короткий текст в чате). */
export function looksLikeInvalidNickAttempt(text, opts = {}) {
    const t = text?.trim();
    if (!t || t.startsWith('{{')) return false;
    if (parseNickFromText(t, opts)) return false;
    if (/^\/nick\b/i.test(t)) return true;
    if (textHasNikWord(t)) return true;
    return false;
}

/** Время первого приветствия продавца в чате (ISO) */
export function findGreetingAnchorInChat(messages, sellerUserId) {
    const marker = (process.env.GREETING_MARKER || 'выдача автоматическая').toLowerCase();
    for (const msg of messages) {
        if (!msg?.text || msg.user?.id !== sellerUserId) continue;
        if (msg.text.toLowerCase().includes(marker)) return msg.createdAt;
    }
    return null;
}

/** Последний ник: сначала от покупателя, иначе /nick продавца (не перетирать покупателя своим /nick). */
export function findLatestBuyerNick(messages, buyerUserId, afterIso, opts = {}) {
    const sellerUserId = opts.sellerUserId ?? null;
    const sellerUsername = opts.sellerUsername ?? null;
    const buyerUsername = opts.buyerUsername ?? null;
    const after = afterIso ? Date.parse(afterIso) : 0;
    let latestBuyer = null;
    let latestSeller = null;
    for (const msg of messages) {
        if (!msg?.text || msg.deal) continue;
        if (after && Date.parse(msg.createdAt) < after) continue;

        if (isSellerNickCommand(msg, sellerUserId, sellerUsername)) {
            const parsed = parseNickFromText(msg.text, { allowNikPhrase: false });
            if (parsed) {
                latestSeller = {
                    ...parsed,
                    via: 'command',
                    fromSeller: true,
                    messageId: msg.id,
                    at: msg.createdAt,
                    raw: msg.text.trim(),
                };
            }
            continue;
        }

        if (!isBuyerUser(msg, buyerUserId, buyerUsername)) continue;
        const parsed = parseNickFromText(msg.text, opts);
        if (parsed) {
            latestBuyer = {
                ...parsed,
                fromSeller: false,
                messageId: msg.id,
                at: msg.createdAt,
                raw: msg.text.trim(),
            };
        }
    }
    return latestBuyer || latestSeller;
}

/** Первый валидный ник покупателя после приветствия (без сообщений продавца). */
export function parseBuyerNick(messages, buyerUserId, afterIso, opts = {}) {
    const buyerUsername = opts.buyerUsername ?? null;
    const after = afterIso ? Date.parse(afterIso) : 0;
    for (const msg of messages) {
        if (!msg?.text || msg.deal) continue;
        if (!isBuyerUser(msg, buyerUserId, buyerUsername)) continue;
        if (after && Date.parse(msg.createdAt) < after) continue;

        const parsed = parseNickFromText(msg.text, opts);
        if (parsed) {
            return {
                ...parsed,
                fromSeller: false,
                messageId: msg.id,
                at: msg.createdAt,
                raw: msg.text.trim(),
            };
        }
    }
    return null;
}

/** Новый ник (/nick или «ник …») после момента afterIso */
export function findBuyerNickAttemptsAfter(
    messages,
    buyerUserId,
    afterIso,
    knownMessageIds = new Set(),
    opts = {},
) {
    const sellerUserId = opts.sellerUserId ?? null;
    const sellerUsername = opts.sellerUsername ?? null;
    const buyerUsername = opts.buyerUsername ?? null;
    const sellerKnownIds = opts.sellerKnownIds ?? null;
    const after = afterIso ? Date.parse(afterIso) : 0;
    let latestBuyer = null;
    let latestSeller = null;
    for (const msg of messages) {
        if (!msg?.text || msg.deal) continue;
        if (after && Date.parse(msg.createdAt) < after) continue;

        if (isSellerNickCommand(msg, sellerUserId, sellerUsername)) {
            if (sellerKnownIds?.has?.(msg.id)) continue;
            const parsed = parseNickFromText(msg.text, { allowNikPhrase: false });
            if (!parsed) continue;
            latestSeller = {
                ...parsed,
                via: 'command',
                fromSeller: true,
                messageId: msg.id,
                at: msg.createdAt,
            };
            continue;
        }

        if (!isBuyerUser(msg, buyerUserId, buyerUsername)) continue;
        if (nickIntakeAlreadyKnown(msg, buyerUserId, knownMessageIds)) continue;
        const parsed = parseNickFromText(msg.text, opts);
        if (!parsed) continue;
        latestBuyer = {
            ...parsed,
            fromSeller: false,
            messageId: msg.id,
            at: msg.createdAt,
        };
    }
    if (latestBuyer) return [latestBuyer];
    if (latestSeller) return [latestSeller];
    return [];
}

/** Новые /nick после уже отправленного заказа (смена ника, только команда) */
export function parseBuyerNickUpdates(
    messages,
    buyerUserId,
    afterIso,
    knownMessageIds = new Set(),
    sellerUserId = null,
    sellerUsername = null,
) {
    const parseOpts = { sellerUserId, sellerUsername };
    const after = afterIso ? Date.parse(afterIso) : 0;
    const updates = [];
    for (const msg of messages) {
        if (!isNickMessageForBuyer(msg, buyerUserId, sellerUserId, parseOpts)) continue;
        if (after && Date.parse(msg.createdAt) < after) continue;
        if (nickIntakeAlreadyKnown(msg, buyerUserId, knownMessageIds)) continue;
        const parsed = parseNickFromMessage(msg, buyerUserId, sellerUserId, parseOpts);
        if (!parsed) continue;
        const fromSeller = isSellerNickCommand(msg, sellerUserId, sellerUsername);
        if (!fromSeller && parsed.via !== 'command') continue;
        updates.push({ ...parsed, messageId: msg.id, at: msg.createdAt });
    }
    return updates;
}

/**
 * Новые сообщения с ником для выдачи: /nick или «ник Steve» (у продавца — только /nick).
 * (для «заказ уже выполнен» — только /nick, см. parseBuyerNickUpdates)
 */
export function parseBuyerNickIntakes(
    messages,
    buyerUserId,
    afterIso,
    knownMessageIds = new Set(),
    opts = {},
) {
    return findBuyerNickAttemptsAfter(messages, buyerUserId, afterIso, knownMessageIds, opts);
}

/** Оплаты не-валюты (предметы) — только для лога */
export function findIgnoredPaidDeals(messages) {
    const ignored = [];
    for (const msg of messages) {
        if (msg.text !== '{{ITEM_PAID}}' || !msg.deal) continue;
        if (msg.deal.direction !== 'OUT') continue;
        const name = msg.deal.item?.name;
        if (isCurrencyKkLot(name) && parseAmountKk(name) != null) continue;
        ignored.push({ dealId: msg.deal.id, itemName: name || '(без названия)' });
    }
    return ignored;
}

/** Все оплаты валюты в чате (несколько покупателей / заказов) */
export function findAllCurrencyPaidDeals(messages) {
    const byId = new Map();
    for (const msg of messages) {
        const deal = buildCurrencyDeal(msg);
        if (!deal) continue;
        const prev = byId.get(deal.dealId);
        if (!prev || Date.parse(deal.paidAt) > Date.parse(prev.paidAt)) {
            byId.set(deal.dealId, deal);
        }
    }
    return [...byId.values()].sort((a, b) => Date.parse(a.paidAt) - Date.parse(b.paidAt));
}

/** Последняя оплата в чате */
export function findPaidDealInChat(messages) {
    const all = findAllCurrencyPaidDeals(messages);
    return all.length ? all[all.length - 1] : null;
}

/**
 * Ищем новые оплаты: системное сообщение {{ITEM_PAID}}, сделка OUT (мы продавец).
 */
export function findNewPaidDeals(messages, seenDealIds) {
    const found = [];
    for (const msg of messages) {
        if (msg.text !== '{{ITEM_PAID}}' || !msg.deal) continue;
        if (msg.deal.direction !== 'OUT') continue;
        const dealId = msg.deal.id;
        if (seenDealIds.has(dealId)) continue;

        const deal = buildCurrencyDeal(msg);
        if (!deal) continue;

        found.push({ ...deal, messageId: msg.id });
    }
    return found;
}

/** Сделка ждёт подтверждения продавцом */
export function findDealsToConfirm(messages, seenConfirmed) {
    const out = [];
    for (const msg of messages) {
        if (!msg.deal || msg.deal.direction !== 'OUT') continue;
        if (msg.deal.status !== 'SENT') continue;
        if (seenConfirmed.has(msg.deal.id)) continue;
        if (msg.text !== '{{ITEM_SENT}}') continue;
        out.push({
            dealId: msg.deal.id,
            chatId: msg.deal.chat?.id,
            itemName: msg.deal.item?.name,
        });
    }
    return out;
}

export function flattenMessages(data) {
    const edges = data?.chatMessages?.edges || [];
    return edges.map((e) => e.node).filter(Boolean);
}

export function flattenChats(data) {
    const edges = data?.chats?.edges || data?.userChats?.edges || [];
    return edges.map((e) => e.node).filter(Boolean);
}
