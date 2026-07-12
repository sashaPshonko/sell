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
    if (item.kind === 'profile_upsell_repeat' && order?.profileUpsellSentAt) {
        return Date.parse(order.profileUpsellSentAt);
    }
    return Date.parse(order?.completedAt || order?.deliveredAt || order?.paidAt || 0);
}

/** После выдачи — первое upsell-сообщение, затем (через 40с) повтор, если 🎁 не купили. */
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

function scheduleUpsellRepeat(state, chatId, orderId) {
    if (
        state.scheduledChatMessages?.some(
            (i) => i.kind === 'profile_upsell_repeat' && i.orderId === orderId,
        )
    ) {
        return;
    }
    if (!state.scheduledChatMessages) state.scheduledChatMessages = [];

    const sendAtMs = Date.now() + UPSELL_REPEAT_DELAY_MS;
    state.scheduledChatMessages.push({
        chatId,
        orderId,
        kind: 'profile_upsell_repeat',
        sendAtMs,
    });
    const order = getOrder(state, orderId);
    setOrderPhase(state, orderId, order?.phase ?? 'completed', {
        profileUpsellRepeatScheduledAt: new Date().toISOString(),
        profileUpsellRepeatSendAtMs: sendAtMs,
    });
}

async function buildScheduledText(client, state, item, order) {
    if (item.kind !== 'profile_upsell' && item.kind !== 'profile_upsell_repeat') {
        return item.text ?? null;
    }

    if (isMarkedProfileLot(order?.itemName)) {
        return null;
    }
    if (order?.premiumRefundUpsellSentAt) {
        return null;
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
        return null;
    }

    let match = null;
    try {
        match = await resolveUpsellMatch(client, state, order);
    } catch (e) {
        console.warn(`[sell] profile-upsell resolve: ${e.message}`);
    }

    if (match?.url) {
        if (item.kind === 'profile_upsell_repeat') {
            return buildProfileUpsellRepeatHint({
                emoji: match.emoji,
                upsellKk: match.kk,
                priceRub: match.priceRub ?? order?.itemPriceRub,
                url: match.url,
            });
        }
        const orderPrice = Math.round(Number(order?.itemPriceRub) || 0);
        const matchPrice = Math.round(Number(match.priceRub) || 0);
        if (orderPrice > 0 && matchPrice > 0 && matchPrice !== orderPrice) {
            console.warn(
                `[sell] profile-upsell ${String(order?.orderId || '').slice(0, 8)}…: ` +
                    `чат-ссылка пропуск — ${matchPrice}₽ ≠ заказ ${orderPrice}₽`,
            );
            return null;
        }
        return buildProfileUpsellHint({
            emoji: match.emoji,
            upsellKk: match.kk,
            baseKk: match.baseKk ?? order?.amountKk,
            priceRub: match.priceRub ?? order?.itemPriceRub,
            url: match.url,
        });
    }

    if (item.kind === 'profile_upsell_repeat') {
        return null;
    }
    return buildProfileBrowseHint({ emoji: profileUpsellEmoji() });
}

function alreadySent(order, kind) {
    if (kind === 'profile_upsell') return Boolean(order?.profileUpsellSentAt);
    if (kind === 'profile_upsell_repeat') return Boolean(order?.profileUpsellRepeatSentAt);
    return false;
}

function markSent(item, order, state) {
    const orderId = item.orderId;
    const orderNow = order || getOrder(state, orderId);

    if (item.kind === 'profile_upsell' && orderNow) {
        setOrderPhase(state, orderId, orderNow.phase, {
            profileUpsellSentAt: new Date().toISOString(),
        });
        scheduleUpsellRepeat(state, item.chatId, orderId);
        return;
    }

    if (item.kind === 'profile_upsell_repeat' && orderNow) {
        setOrderPhase(state, orderId, orderNow.phase, {
            profileUpsellRepeatSentAt: new Date().toISOString(),
        });
    }
}

export async function flushScheduledChatMessages(client, state) {
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
            const text = await buildScheduledText(client, state, item, order);
            if (!text) {
                continue;
            }
            await sendChatMessage(client, item.chatId, text);
            markSent(item, order, state);
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
