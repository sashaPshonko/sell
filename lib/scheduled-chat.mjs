import {
    POST_DELIVERY_CHAT_DELAY_MS,
    UPSELL_REPEAT_DELAY_MS,
} from './pay-bonus.mjs';
import {
    buildProfileUpsellHint,
    buildProfileUpsellRepeatHint,
    buildProfileBrowseHint,
} from '../messages.mjs';
import { sendChatMessage } from '../chat.mjs';
import { getOrder, setOrderPhase, ordersInChat } from '../state.mjs';
import {
    resolveProfileUpsell,
    profileUpsellEmoji,
    isMarkedProfileLot,
} from './profile-upsell.mjs';

const MAX_SEND_RETRIES = 3;

function queueHasProfileUpsell(state, chatId) {
    return state.scheduledChatMessages?.some(
        (item) =>
            item.chatId === chatId &&
            (item.kind === 'profile_upsell' || item.kind === 'profile_upsell_repeat'),
    );
}

function queueHasUpsellRepeat(state, orderId) {
    return state.scheduledChatMessages?.some(
        (i) => i.kind === 'profile_upsell_repeat' && i.orderId === orderId,
    );
}

/** Покупатель уже взял 🎁 после sinceMs (выдача или первое upsell-сообщение). */
function buyerBoughtGiftSince(state, chatId, buyerId, sinceMs) {
    if (!buyerId || !sinceMs) return false;

    const pool = [
        ...(ordersInChat(state, chatId) || []),
        ...Object.values(state.orders || {}),
    ];
    for (const o of pool) {
        if (!o || o.buyerId !== buyerId) continue;
        if (!isMarkedProfileLot(o.itemName)) continue;
        if (o.phase === 'cancelled') continue;
        const t = Date.parse(o.paidAt || o.createdAt || 0);
        if (t >= sinceMs) return true;
    }
    return false;
}

async function resolveUpsellMatch(client, state, order) {
    const sellerUserId = state.sellerUserId;
    const sellerUsername = state.sellerUsername ?? null;
    if (!sellerUserId) return null;
    return resolveProfileUpsell(client, order, sellerUserId, sellerUsername);
}

function giftCheckSinceMs(order, item) {
    if (item.kind === 'profile_upsell_repeat') {
        const first =
            order?.profileUpsellSentAt || order?.premiumRefundUpsellSentAt || null;
        if (first) return Date.parse(first);
    }
    return Date.parse(order?.completedAt || order?.deliveredAt || order?.paidAt || 0);
}

/** Ссылка с первого upsell — для повтора без повторного resolve. */
function cachedUpsellMatch(order) {
    const url = String(order?.profileUpsellUrl || '').trim();
    if (!url) return null;
    return {
        url,
        kk: Number(order.profileUpsellKk) || 0,
        priceRub: order.profileUpsellPriceRub,
        emoji: order.profileUpsellEmoji,
        baseKk: order.profileUpsellBaseKk,
    };
}

/** После выдачи — первое upsell, затем (через 40с) повтор той же ссылки, если 🎁 не купили. */
export function schedulePostDeliveryMessages(state, chatId, orderId) {
    const order = getOrder(state, orderId);
    if (order?.profileUpsellScheduledAt) return;
    if (queueHasProfileUpsell(state, chatId)) return;

    if (!state.scheduledChatMessages) state.scheduledChatMessages = [];

    const sendAtMs = Date.now() + POST_DELIVERY_CHAT_DELAY_MS;
    state.scheduledChatMessages.push({
        chatId,
        orderId,
        kind: 'profile_upsell',
        sendAtMs,
    });
    setOrderPhase(state, orderId, order?.phase ?? 'completed', {
        profileUpsellScheduledAt: new Date().toISOString(),
        profileUpsellSendAtMs: sendAtMs,
    });
}

/** Повтор ссылки через 40с (после выдачи или после автовозврата), если 🎁 ещё не купили. */
export function scheduleUpsellRepeat(state, chatId, orderId, { fromSentAtMs } = {}) {
    if (queueHasUpsellRepeat(state, orderId)) return;

    const order = getOrder(state, orderId);
    if (order?.profileUpsellRepeatSentAt) return;
    // Повтор только если в первом сообщении была реальная ссылка
    if (!String(order?.profileUpsellUrl || '').trim()) return;

    if (!state.scheduledChatMessages) state.scheduledChatMessages = [];

    const base = Number.isFinite(fromSentAtMs)
        ? fromSentAtMs
        : Date.parse(order?.profileUpsellSentAt || order?.premiumRefundUpsellSentAt || '') ||
          Date.now();
    const sendAtMs = Math.max(Date.now(), base + UPSELL_REPEAT_DELAY_MS);

    state.scheduledChatMessages.push({
        chatId,
        orderId,
        kind: 'profile_upsell_repeat',
        sendAtMs,
    });
    setOrderPhase(state, orderId, order?.phase ?? 'completed', {
        profileUpsellRepeatScheduledAt: new Date().toISOString(),
        profileUpsellRepeatSendAtMs: sendAtMs,
    });
    console.log(
        `[sell] profile-upsell repeat запланирован ${String(orderId).slice(0, 8)}… ` +
            `через ${Math.max(0, Math.round((sendAtMs - Date.now()) / 1000))}с`,
    );
}

/** После рестарта: первое ушло со ссылкой, повтор пропал из очереди. */
export function restorePendingUpsellRepeats(state) {
    for (const order of Object.values(state.orders || {})) {
        const firstSentAt = order?.profileUpsellSentAt || order?.premiumRefundUpsellSentAt;
        if (!firstSentAt || order.profileUpsellRepeatSentAt) continue;
        if (!String(order.profileUpsellUrl || '').trim()) continue;
        const orderId = order.orderId || order.dealId;
        const chatId = order.chatId;
        if (!orderId || !chatId) continue;
        if (queueHasUpsellRepeat(state, orderId)) continue;
        scheduleUpsellRepeat(state, chatId, orderId, {
            fromSentAtMs: Date.parse(firstSentAt),
        });
    }
}

/**
 * @returns {{ text: string|null, drop: boolean, match: object|null }}
 */
async function buildScheduledPayload(client, state, item, order) {
    if (item.kind !== 'profile_upsell' && item.kind !== 'profile_upsell_repeat') {
        return { text: item.text ?? null, drop: !item.text, match: null };
    }

    if (isMarkedProfileLot(order?.itemName)) {
        return { text: null, drop: true, match: null };
    }
    // После автовозврата не шлём «первое» post-delivery upsell; повтор через 40с — да
    if (order?.premiumRefundUpsellSentAt && item.kind === 'profile_upsell') {
        return { text: null, drop: true, match: null };
    }

    const sinceMs = giftCheckSinceMs(order, item);
    if (buyerBoughtGiftSince(state, item.chatId, order?.buyerId, sinceMs)) {
        const label =
            item.kind === 'profile_upsell_repeat'
                ? `${UPSELL_REPEAT_DELAY_MS / 1000}с после первой ссылки`
                : 'окно после выдачи';
        console.log(
            `[sell] profile-upsell ${String(order?.orderId || '').slice(0, 8)}…: пропуск ${item.kind} — уже купили 🎁 (${label})`,
        );
        return { text: null, drop: true, match: null };
    }

    // Повтор — та же ссылка, что уже отправили
    if (item.kind === 'profile_upsell_repeat') {
        const cached = cachedUpsellMatch(order);
        if (cached?.url) {
            const text = buildProfileUpsellRepeatHint({
                upsellKk: cached.kk,
                baseKk: cached.baseKk ?? order?.amountKk,
                url: cached.url,
            });
            return { text: text || null, drop: !text, match: cached };
        }
        // Старые заказы без кэша — один resolve
        let match = null;
        try {
            match = await resolveUpsellMatch(client, state, order);
        } catch (e) {
            console.warn(`[sell] profile-upsell resolve: ${e.message}`);
        }
        if (match?.url) {
            return {
                text: buildProfileUpsellRepeatHint({
                    upsellKk: match.kk,
                    baseKk: match.baseKk ?? order?.amountKk,
                    url: match.url,
                }),
                drop: false,
                match,
            };
        }
        console.warn(
            `[sell] profile-upsell ${String(order?.orderId || '').slice(0, 8)}…: повтор без кэша ссылки — drop`,
        );
        return { text: null, drop: true, match: null };
    }

    let match = null;
    try {
        match = await resolveUpsellMatch(client, state, order);
    } catch (e) {
        console.warn(`[sell] profile-upsell resolve: ${e.message}`);
    }

    if (match?.url) {
        const orderPrice = Math.round(Number(order?.itemPriceRub) || 0);
        const matchPrice = Math.round(Number(match.priceRub) || 0);
        if (orderPrice > 0 && matchPrice > 0 && matchPrice !== orderPrice) {
            console.warn(
                `[sell] profile-upsell ${String(order?.orderId || '').slice(0, 8)}…: ` +
                    `чат-ссылка пропуск — ${matchPrice}₽ ≠ заказ ${orderPrice}₽`,
            );
            return { text: null, drop: true, match: null };
        }
        return {
            text: buildProfileUpsellHint({
                emoji: match.emoji,
                upsellKk: match.kk,
                baseKk: match.baseKk ?? order?.amountKk,
                priceRub: match.priceRub ?? order?.itemPriceRub,
                url: match.url,
            }),
            drop: false,
            match,
        };
    }

    return {
        text: buildProfileBrowseHint({ emoji: profileUpsellEmoji() }),
        drop: false,
        match: null,
    };
}

function alreadySent(order, kind) {
    if (kind === 'profile_upsell') return Boolean(order?.profileUpsellSentAt);
    if (kind === 'profile_upsell_repeat') return Boolean(order?.profileUpsellRepeatSentAt);
    return false;
}

function markSent(item, order, state, match) {
    const orderId = item.orderId;
    const orderNow = order || getOrder(state, orderId);

    if (item.kind === 'profile_upsell' && orderNow) {
        const extra = {
            profileUpsellSentAt: new Date().toISOString(),
        };
        if (match?.url) {
            extra.profileUpsellUrl = match.url;
            extra.profileUpsellKk = match.kk;
            extra.profileUpsellPriceRub = match.priceRub ?? null;
            extra.profileUpsellEmoji = match.emoji ?? null;
            extra.profileUpsellBaseKk = match.baseKk ?? orderNow.amountKk ?? null;
        }
        setOrderPhase(state, orderId, orderNow.phase, extra);
        // Повтор только если была ссылка (не browse-hint без url)
        if (match?.url) {
            scheduleUpsellRepeat(state, item.chatId, orderId);
        }
        return;
    }

    if (item.kind === 'profile_upsell_repeat' && orderNow) {
        const extra = { profileUpsellRepeatSentAt: new Date().toISOString() };
        if (match?.url && !orderNow.profileUpsellUrl) {
            extra.profileUpsellUrl = match.url;
            extra.profileUpsellKk = match.kk;
        }
        setOrderPhase(state, orderId, orderNow.phase, extra);
    }
}

export async function flushScheduledChatMessages(client, state) {
    restorePendingUpsellRepeats(state);

    const queue = state.scheduledChatMessages;
    if (!queue?.length) return;

    state.scheduledChatMessages = queue.filter((item) => item.kind !== 'repeat_promo');

    const now = Date.now();
    const remain = [];

    for (const item of state.scheduledChatMessages) {
        if (item.sendAtMs > now) {
            remain.push(item);
            continue;
        }

        const order = item.orderId ? getOrder(state, item.orderId) : null;
        if (alreadySent(order, item.kind)) continue;

        const retries = Number(item.sendRetries || 0);
        try {
            const { text, drop, match } = await buildScheduledPayload(
                client,
                state,
                item,
                order,
            );
            if (!text) {
                if (!drop && Date.now() - item.sendAtMs < 3600_000 && retries + 1 < MAX_SEND_RETRIES) {
                    remain.push({
                        ...item,
                        sendAtMs: now + 30_000,
                        sendRetries: retries + 1,
                    });
                }
                continue;
            }
            await sendChatMessage(client, item.chatId, text);
            markSent(item, order, state, match);
            console.log(
                `[sell] отложенное сообщение (${item.kind}) чат ${item.chatId.slice(0, 8)}…`,
            );
        } catch (e) {
            console.warn(`[sell] отложенное сообщение: ${e.message}`);
            if (retries + 1 >= MAX_SEND_RETRIES) {
                console.warn(
                    `[sell] отложенное (${item.kind}) чат ${item.chatId.slice(0, 8)}…: снято с очереди после ${MAX_SEND_RETRIES} попыток`,
                );
                continue;
            }
            if (Date.now() - item.sendAtMs < 3600_000) {
                remain.push({
                    ...item,
                    sendAtMs: now + 30_000,
                    sendRetries: retries + 1,
                });
            }
        }
    }

    state.scheduledChatMessages = remain;
}
