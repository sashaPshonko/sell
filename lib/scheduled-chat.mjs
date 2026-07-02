import { POST_DELIVERY_CHAT_DELAY_MS } from './pay-bonus.mjs';
import {
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

const MAX_SEND_RETRIES = 3;

function queueHasProfileUpsell(state, chatId) {
    return state.scheduledChatMessages?.some(
        (item) => item.kind === 'profile_upsell' && item.chatId === chatId,
    );
}

/** После выдачи — отложенный upsell на профиль (без бонуса за повтор). */
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

async function buildScheduledText(client, state, item, order) {
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
    if (kind === 'profile_upsell') return Boolean(order?.profileUpsellSentAt);
    return false;
}

function markSent(orderId, order, kind, state) {
    if (kind === 'profile_upsell' && order) {
        setOrderPhase(state, orderId, order.phase, {
            profileUpsellSentAt: new Date().toISOString(),
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
            markSent(item.orderId, order, item.kind, state);
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
