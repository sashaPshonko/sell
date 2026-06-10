import {
    REPEAT_PROMO_DELAY_MS,
    PROFILE_UPSELL_DELAY_AFTER_PROMO_MS,
} from './pay-bonus.mjs';
import {
    buildRepeatPurchaseHint,
    buildProfileUpsellHint,
    buildProfileBrowseHint,
} from '../messages.mjs';
import { sendChatMessage } from '../chat.mjs';
import { getOrder, setOrderPhase } from '../state.mjs';
import {
    resolveProfileUpsell,
    profileUpsellEmoji,
    isMarkedProfileLot,
} from './profile-upsell.mjs';

export function scheduleRepeatPromoMessage(state, chatId, orderId) {
    const order = getOrder(state, orderId);
    if (order?.repeatPromoScheduledAt) return;

    if (!state.scheduledChatMessages) state.scheduledChatMessages = [];

    const sendAtMs = Date.now() + REPEAT_PROMO_DELAY_MS;
    state.scheduledChatMessages.push({
        chatId,
        orderId,
        kind: 'repeat_promo',
        sendAtMs,
    });
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

function alreadySent(order, kind) {
    if (kind === 'repeat_promo') return Boolean(order?.repeatPromoSentAt);
    if (kind === 'profile_upsell') return Boolean(order?.profileUpsellSentAt);
    return false;
}

function markSent(orderId, order, kind, state) {
    if (kind === 'repeat_promo') {
        setOrderPhase(state, orderId, order.phase, {
            repeatPromoSentAt: new Date().toISOString(),
        });
        return;
    }
    if (kind === 'profile_upsell') {
        setOrderPhase(state, orderId, order.phase, {
            profileUpsellSentAt: new Date().toISOString(),
        });
    }
}

export async function flushScheduledChatMessages(client, state) {
    const queue = state.scheduledChatMessages;
    if (!queue?.length) return;

    const now = Date.now();
    const remain = [];

    for (const item of queue) {
        if (item.sendAtMs > now) {
            remain.push(item);
            continue;
        }

        const order = item.orderId ? getOrder(state, item.orderId) : null;
        if (order && alreadySent(order, item.kind)) continue;

        try {
            const text = await buildScheduledText(client, state, item, order);
            if (!text) {
                continue;
            }
            await sendChatMessage(client, item.chatId, text);
            if (item.orderId && order) {
                markSent(item.orderId, order, item.kind, state);
            }
            console.log(
                `[sell] отложенное сообщение (${item.kind}) чат ${item.chatId.slice(0, 8)}…`,
            );
        } catch (e) {
            console.warn(`[sell] отложенное сообщение: ${e.message}`);
            if (Date.now() - item.sendAtMs < 3600_000) {
                remain.push({ ...item, sendAtMs: now + 30_000 });
            }
        }
    }

    state.scheduledChatMessages = remain;
}
