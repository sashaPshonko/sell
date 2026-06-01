import { isBanCommand, isUnbanCommand, findAllCurrencyPaidDeals } from '../parse.mjs';
import { ordersInChat, setOrderPhase } from '../state.mjs';
import {
    buildBannedBuyerRefundHint,
    buildBannedBuyerBlockedNotice,
} from '../messages.mjs';
import { sendChatMessage } from '../chat.mjs';
import { dispatchCancelOrder } from '../dispatch.mjs';
import { cancelDealOnPlayerok } from '../cancel.mjs';
import { isActionableOrder } from './deal-cutoff.mjs';

export function isBuyerBanned(state, buyerId) {
    if (!buyerId) return false;
    return Boolean(state.bannedBuyers?.[buyerId]);
}

export function banBuyer(state, buyerId, extra = {}) {
    if (!buyerId) return;
    if (!state.bannedBuyers) state.bannedBuyers = {};
    state.bannedBuyers[buyerId] = {
        bannedAt: new Date().toISOString(),
        ...extra,
    };
}

export function unbanBuyer(state, buyerId) {
    if (!buyerId || !state.bannedBuyers?.[buyerId]) return false;
    delete state.bannedBuyers[buyerId];
    return true;
}

/** Покупатели в чате (не продавец). */
export function collectChatBuyerIds(state, chatId, messages, sellerUserId) {
    const ids = new Set();
    for (const order of ordersInChat(state, chatId)) {
        if (order.buyerId && order.buyerId !== sellerUserId) ids.add(order.buyerId);
    }
    for (const deal of findAllCurrencyPaidDeals(messages)) {
        if (deal.buyerId && deal.buyerId !== sellerUserId) ids.add(deal.buyerId);
    }
    for (const msg of messages) {
        const uid = msg.user?.id;
        if (uid && uid !== sellerUserId) ids.add(uid);
    }
    return [...ids];
}

/** Кого банить по /ban в этом чате. */
export function resolveBanTargetBuyerId(state, chatId, messages, sellerUserId) {
    const buyers = collectChatBuyerIds(state, chatId, messages, sellerUserId);
    if (buyers.length === 1) return buyers[0];
    if (!buyers.length) return null;

    let latest = null;
    for (const msg of messages) {
        const uid = msg.user?.id;
        if (!uid || uid === sellerUserId) continue;
        const at = msg.createdAt;
        if (!at) continue;
        if (!latest || Date.parse(at) > Date.parse(latest.at)) {
            latest = { id: uid, at };
        }
    }
    return latest?.id ?? buyers[0];
}

/**
 * @returns {Promise<{ playerokCancelled: boolean, cancelled: boolean }>}
 */
export async function cancelOrderAsRefund(client, state, order) {
    if (!order || order.phase === 'completed' || order.phase === 'cancelled') {
        return { playerokCancelled: false, cancelled: false };
    }

    const wasDispatched = order.phase === 'dispatched';
    setOrderPhase(state, order.orderId, 'cancelled', {
        cancelledAt: new Date().toISOString(),
        cancelReason: 'banned_buyer',
    });
    if (wasDispatched) {
        await dispatchCancelOrder(order.orderId);
    }

    let playerokCancelled = false;
    if (process.env.AUTO_CANCEL_PLAYEROK === '1') {
        try {
            await cancelDealOnPlayerok(client, order.orderId);
            setOrderPhase(state, order.orderId, 'cancelled', {
                playerokCancelledAt: new Date().toISOString(),
            });
            playerokCancelled = true;
        } catch (e) {
            console.warn(
                `[sell] банлист: PlayerOK отмена ${order.orderId.slice(0, 8)}…: ${e.message}`,
            );
        }
    }

    return { playerokCancelled, cancelled: true };
}

/**
 * Отмена открытых заказов забаненного покупателя + сообщение в чат (один раз за проход).
 */
export async function rejectBannedBuyerOrdersInChat(client, state, chatId) {
    const orders = ordersInChat(state, chatId).filter(
        (o) => isBuyerBanned(state, o.buyerId) && isActionableOrder(o),
    );
    if (!orders.length) return;

    let sendHint = false;
    let lastPlayerokCancelled = false;
    for (const order of orders) {
        const { cancelled, playerokCancelled } = await cancelOrderAsRefund(client, state, order);
        if (!cancelled) continue;
        if (playerokCancelled) lastPlayerokCancelled = true;

        console.log(
            `[sell] банлист: заказ ${order.orderId.slice(0, 8)}… отклонён (${order.buyer})`,
        );

        setOrderPhase(state, order.orderId, 'cancelled', {
            bannedRefundHintSent: true,
            cancelReason: 'banned_buyer',
        });
        if (!order.bannedRefundHintSent) sendHint = true;
    }

    if (sendHint) {
        try {
            await sendChatMessage(
                client,
                chatId,
                buildBannedBuyerRefundHint(lastPlayerokCancelled),
            );
        } catch (e) {
            console.warn(`[sell] банлист, ответ в чат: ${e.message}`);
        }
    }
}

async function cancelBuyerOpenOrdersInChat(client, state, chatId, buyerId) {
    let count = 0;
    let playerokCancelled = false;
    for (const order of ordersInChat(state, chatId)) {
        if (order.buyerId !== buyerId) continue;
        if (!isActionableOrder(order)) continue;
        const result = await cancelOrderAsRefund(client, state, order);
        if (!result.cancelled) continue;
        count += 1;
        if (result.playerokCancelled) playerokCancelled = true;
        console.log(
            `[sell] банлист: заказ ${order.orderId.slice(0, 8)}… отменён (/ban)`,
        );
    }
    return { count, playerokCancelled };
}

/**
 * /ban и /unban — только в сообщениях продавца (покупательские игнорируются).
 * @returns {string[]} id обработанных сообщений
 */
export async function applySellerBanCommands(
    client,
    state,
    chatId,
    messages,
    sellerUserId,
    knownIds,
) {
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);

    const sellerBanMsgs = messages
        .filter((msg) => {
            if (!msg?.text || msg.deal) return false;
            if (msg.user?.id !== sellerUserId) return false;
            return isBanCommand(msg.text) || isUnbanCommand(msg.text);
        })
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    for (const msg of sellerBanMsgs) {
        if (known.has(msg.id)) continue;
        known.add(msg.id);

        if (isUnbanCommand(msg.text)) {
            const buyerId = resolveBanTargetBuyerId(state, chatId, messages, sellerUserId);
            if (buyerId && unbanBuyer(state, buyerId)) {
                console.log(
                    `[sell] банлист: разбан ${buyerId.slice(0, 8)}… (чат ${chatId.slice(0, 8)}…)`,
                );
            }
            continue;
        }

        if (!isBanCommand(msg.text)) continue;

        const buyerId = resolveBanTargetBuyerId(state, chatId, messages, sellerUserId);
        if (!buyerId) {
            console.log(
                `[sell] /ban: не найден покупатель (чат ${chatId.slice(0, 8)}…)`,
            );
            continue;
        }

        banBuyer(state, buyerId, { chatId, messageId: msg.id });
        console.log(
            `[sell] банлист: бан ${buyerId.slice(0, 8)}… (чат ${chatId.slice(0, 8)}…)`,
        );

        const { count, playerokCancelled } = await cancelBuyerOpenOrdersInChat(
            client,
            state,
            chatId,
            buyerId,
        );

        try {
            await sendChatMessage(client, chatId, buildBannedBuyerBlockedNotice());
        } catch (e) {
            console.warn(`[sell] банлист, уведомление о бане: ${e.message}`);
        }

        if (count > 0) {
            try {
                await sendChatMessage(
                    client,
                    chatId,
                    buildBannedBuyerRefundHint(playerokCancelled),
                );
            } catch (e) {
                console.warn(`[sell] банлист, ответ в чат: ${e.message}`);
            }
        }
    }

    return [...known];
}
