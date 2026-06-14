import {
    REPEAT_PROMO_DELAY_MS,
    PROFILE_UPSELL_DELAY_AFTER_PROMO_MS,
    REPEAT_WINDOW_MS,
} from './pay-bonus.mjs';
import {
    buildRepeatPurchaseHint,
    buildProfileUpsellHint,
    buildProfileBrowseHint,
} from '../messages.mjs';
import { sendChatMessage } from '../chat.mjs';
import { getOrder, setOrderPhase, ensureChat } from '../state.mjs';
import {
    resolveProfileUpsell,
    profileUpsellEmoji,
    isMarkedProfileLot,
} from './profile-upsell.mjs';

const MAX_SEND_RETRIES = 3;

function chatRepeatPromoRecentlySent(state, chatId) {
    const sentAt = state.chats?.[chatId]?.repeatPromoSentAt;
    if (!sentAt) return false;
    return Date.now() - Date.parse(sentAt) < REPEAT_WINDOW_MS;
}

function queueHasRepeatPromo(state, chatId) {
    return state.scheduledChatMessages?.some(
        (item) => item.kind === 'repeat_promo' && item.chatId === chatId,
    );
}

function dedupeRepeatPromoQueue(state) {
    const queue = state.scheduledChatMessages;
    if (!queue?.length) return;

    const seenChats = new Set();
    state.scheduledChatMessages = queue.filter((item) => {
        if (item.kind !== 'repeat_promo') return true;
        if (seenChats.has(item.chatId)) return false;
        seenChats.add(item.chatId);
        return true;
    });
}

export function scheduleRepeatPromoMessage(state, chatId, orderId) {
    const order = getOrder(state, orderId);
    if (order?.repeatPromoSentAt) return;
    if (order?.repeatPromoScheduledAt) return;
    if (chatRepeatPromoRecentlySent(state, chatId)) return;
    if (queueHasRepeatPromo(state, chatId)) return;

    if (!state.scheduledChatMessages) state.scheduledChatMessages = [];

    const sendAtMs = Date.now() + REPEAT_PROMO_DELAY_MS;
    state.scheduledChatMessages.push({
        chatId,
        orderId,
        kind: 'repeat_promo',
        sendAtMs,
    });
    dedupeRepeatPromoQueue(state);
    setOrderPhase(state, orderId, order?.phase ?? 'completed', {
        repeatPromoScheduledAt: new Date().toISOString(),
        repeatPromoSendAtMs: sendAtMs,
    });

    scheduleProfileUpsellMessage(state, chatId, orderId, sendAtMs);
}

function scheduleProfileUpsellMessage(state, chatId, orderId, repeatPromoSendAtMs) {
    const order = getOrder(state, orderId);
    if (order?.profileUpsellScheduledAt) return;

    const sendAtMs = repeatPromoSendAtMs + PROFILE_UPSELL_DELAY_AFTER_PROMO_MS;
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

async function buildScheduledText(client, state, item, order) {
    if (item.kind === 'repeat_promo') {
        return buildRepeatPurchaseHint();
    }
    if (item.kind === 'profile_upsell') {
        if (isMarkedProfileLot(order?.itemName)) {
            return null;
        }
        if (order?.premiumRefundUpsellSentAt) {
            return null;
        }
        const sellerUserId = state.sellerUserId;
        const sellerUsername = state.sellerUsername ?? null;
        let match = null;
        if (sellerUserId) {
            match = await resolveProfileUpsell(
                client,
                order,
                sellerUserId,
                sellerUsername,
            );
        }
        if (match?.url) {
            return buildProfileUpsellHint({
                emoji: match.emoji,
                upsellKk: match.kk,
                baseKk: match.baseKk ?? order?.amountKk,
                priceRub: match.priceRub ?? order?.itemPriceRub,
                url: match.url,
            });
        }
        return buildProfileBrowseHint({ emoji: profileUpsellEmoji() });
    }
    return item.text ?? null;
}

function alreadySent(state, chatId, order, kind) {
    if (kind === 'repeat_promo') {
        return Boolean(order?.repeatPromoSentAt) || chatRepeatPromoRecentlySent(state, chatId);
    }
    if (kind === 'profile_upsell') return Boolean(order?.profileUpsellSentAt);
    return false;
}

function markSent(orderId, order, kind, state, chatId) {
    const now = new Date().toISOString();
    if (kind === 'repeat_promo') {
        if (order) {
            setOrderPhase(state, orderId, order.phase, { repeatPromoSentAt: now });
        }
        if (chatId) {
            ensureChat(state, chatId).repeatPromoSentAt = now;
        }
        return;
    }
    if (kind === 'profile_upsell' && order) {
        setOrderPhase(state, orderId, order.phase, {
            profileUpsellSentAt: now,
        });
    }
}

export async function flushScheduledChatMessages(client, state) {
    const queue = state.scheduledChatMessages;
    if (!queue?.length) return;

    dedupeRepeatPromoQueue(state);

    const now = Date.now();
    const remain = [];

    for (const item of state.scheduledChatMessages) {
        if (item.sendAtMs > now) {
            remain.push(item);
            continue;
        }

        const order = item.orderId ? getOrder(state, item.orderId) : null;
        if (alreadySent(state, item.chatId, order, item.kind)) continue;

        const retries = Number(item.sendRetries || 0);
        try {
            const text = await buildScheduledText(client, state, item, order);
            if (!text) {
                continue;
            }
            await sendChatMessage(client, item.chatId, text);
            markSent(item.orderId, order, item.kind, state, item.chatId);
            console.log(
                `[sell] отложенное сообщение (${item.kind}) чат ${item.chatId.slice(0, 8)}…`,
            );
        } catch (e) {
            console.warn(`[sell] отложенное сообщение: ${e.message}`);
            if (retries + 1 >= MAX_SEND_RETRIES) {
                console.warn(
                    `[sell] отложенное (${item.kind}) чат ${item.chatId.slice(0, 8)}…: снято с очереди после ${MAX_SEND_RETRIES} попыток`,
                );
                if (item.kind === 'repeat_promo') {
                    markSent(item.orderId, order, item.kind, state, item.chatId);
                }
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
