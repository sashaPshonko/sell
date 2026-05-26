import {
    parseBuyerNick,
    parseBuyerNickUpdates,
    findLatestBuyerNick,
    findGreetingAnchorInChat,
    isCancelCommand,
} from './parse.mjs';
import {
    ensureChat,
    getBuyerSession,
    getOrder,
    upsertOrder,
    setOrderPhase,
    ordersInChat,
} from './state.mjs';
import { hasGreetingInChat, buildOrderCancelledHint } from './messages.mjs';
import { sendGreeting, sendChatMessage } from './chat.mjs';
import { dispatchOrder, dispatchNickUpdate, dispatchCancelOrder } from './dispatch.mjs';
import { cancelDealOnPlayerok } from './cancel.mjs';
import { DELIVERY_ANARCHY } from './messages.mjs';
import { isStaleDeal, isActionableOrder } from './lib/deal-cutoff.mjs';

/**
 * Синхронизирует ник покупателя на весь чат (все его заказы).
 * @returns {string|null}
 */
function nickMessagesAfter(session, greetingAtIso) {
    const candidates = [greetingAtIso, session.nickResetAt].filter(Boolean);
    if (!candidates.length) return null;
    return candidates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

export function syncChatNick(state, chatId, messages, buyerId, greetingAtIso) {
    const session = getBuyerSession(state, chatId, buyerId);
    const after = nickMessagesAfter(session, greetingAtIso);

    const latest = findLatestBuyerNick(messages, buyerId, after);
    const first = parseBuyerNick(messages, buyerId, after);
    const pick = latest?.via === 'command' ? latest : first || latest;

    if (pick?.nick) {
        const changed = session.nick !== pick.nick || session.messageId !== pick.messageId;
        session.nick = pick.nick;
        session.via = pick.via;
        session.messageId = pick.messageId;
        session.nickAt = pick.at;
        if (changed) {
            for (const order of ordersInChat(state, chatId)) {
                if (order.buyerId === buyerId && order.phase !== 'completed' && order.phase !== 'cancelled') {
                    order.nick = pick.nick;
                }
            }
        }
        return pick.nick;
    }

    return session.nick || null;
}

export async function ensureChatGreeting(client, state, chatId, messages, sellerUserId, deals) {
    const chat = ensureChat(state, chatId);
    const hasOpen = deals.some((d) => {
        const o = getOrder(state, d.dealId);
        return isActionableOrder(o);
    });
    if (!hasOpen) return chat.greetingAt || null;

    if (!chat.greetingAt) {
        const anchor = findGreetingAnchorInChat(messages, sellerUserId);
        if (anchor) chat.greetingAt = anchor;
    }

    if (chat.greetingSent || hasGreetingInChat(messages, sellerUserId)) {
        chat.greetingSent = true;
        if (!chat.greetingAt) {
            chat.greetingAt = findGreetingAnchorInChat(messages, sellerUserId) || new Date().toISOString();
        }
        return chat.greetingAt;
    }

    await sendGreeting(client, chatId, deals[0]?.dealId);
    chat.greetingSent = true;
    chat.greetingAt = new Date().toISOString();
    console.log(`[sell] чат ${chatId.slice(0, 8)}…: приветствие`);

    for (const paid of deals) {
        setOrderPhase(state, paid.dealId, 'awaiting_nick', {
            greetedAt: chat.greetingAt,
        });
    }
    return chat.greetingAt;
}

/**
 * /cancel — отменить все незавершённые заказы покупателя в этом чате.
 */
export async function applyCancelCommands(
    client,
    state,
    chatId,
    messages,
    buyerId,
    greetingAtIso,
    knownIds,
) {
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
    const after = greetingAtIso ? Date.parse(greetingAtIso) : 0;
    let replied = false;

    for (const msg of messages) {
        if (!msg?.text || msg.deal) continue;
        if (msg.user?.id !== buyerId) continue;
        if (after && Date.parse(msg.createdAt) < after) continue;
        if (known.has(msg.id)) continue;
        if (!isCancelCommand(msg.text)) continue;

        known.add(msg.id);

        let cancelled = 0;
        let playerokCancelled = 0;
        for (const order of ordersInChat(state, chatId)) {
            if (order.buyerId !== buyerId) continue;
            if (order.phase === 'completed' || order.phase === 'cancelled') continue;

            const wasDispatched = order.phase === 'dispatched';
            setOrderPhase(state, order.orderId, 'cancelled', {
                cancelledAt: new Date().toISOString(),
            });
            if (wasDispatched) {
                await dispatchCancelOrder(order.orderId);
            }

            if (process.env.AUTO_CANCEL_PLAYEROK === '1') {
                try {
                    await cancelDealOnPlayerok(client, order.orderId);
                    setOrderPhase(state, order.orderId, 'cancelled', {
                        playerokCancelledAt: new Date().toISOString(),
                    });
                    playerokCancelled += 1;
                } catch (e) {
                    console.warn(
                        `[sell] PlayerOK отмена ${order.orderId.slice(0, 8)}…: ${e.message}`,
                    );
                }
            }

            cancelled += 1;
            console.log(`[sell] ${order.orderId.slice(0, 8)}…: отменён покупателем`);
        }

        if (!replied) {
            try {
                await sendChatMessage(
                    client,
                    chatId,
                    buildOrderCancelledHint(playerokCancelled > 0),
                );
            } catch (e) {
                console.warn(`[sell] отмена, ответ в чат: ${e.message}`);
            }
            replied = true;
        }

        if (!cancelled) {
            console.log(`[sell] /cancel: нечего отменять (чат ${chatId.slice(0, 8)}…)`);
        }
    }
    return known;
}

/**
 * Новый /nick — обновить сессию и перезапустить выдачу у dispatched (если завис).
 */
export async function applyNickCommandUpdates(state, chatId, messages, buyerId, greetingAtIso, knownIds) {
    const session = getBuyerSession(state, chatId, buyerId);
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
    const after = nickMessagesAfter(session, greetingAtIso);
    const updates = parseBuyerNickUpdates(messages, buyerId, after, known);

    for (const u of updates) {
        known.add(u.messageId);
        const changed = session.nick !== u.nick;
        session.nick = u.nick;
        session.via = u.via;
        session.messageId = u.messageId;
        session.nickAt = u.at;

        console.log(`[sell] чат ${chatId.slice(0, 8)}…: ник → ${u.nick}`);

        for (const order of ordersInChat(state, chatId)) {
            if (order.buyerId !== buyerId || order.phase === 'completed' || order.phase === 'cancelled') {
                continue;
            }
            order.nick = u.nick;
            order.wrongNickWarned = false;

            if (order.phase === 'dispatched' && changed) {
                await dispatchNickUpdate(order.orderId, u.nick);
            } else if (order.phase !== 'dispatched') {
                setOrderPhase(state, order.orderId, 'awaiting_nick', {
                    nick: u.nick,
                    lastError: null,
                });
            }
        }
    }
    return known;
}

/** Все незавершённые заказы чата → sellbot, строго по времени оплаты */
export async function flushChatDispatchQueue(state, deals) {
    const sorted = [...deals].sort((a, b) => Date.parse(a.paidAt) - Date.parse(b.paidAt));

    for (const paid of sorted) {
        const oid = paid.dealId;
        const order = getOrder(state, oid);
        if (!order) continue;
        if (order.phase === 'completed' || order.phase === 'dispatched' || order.phase === 'cancelled') {
            continue;
        }

        const chatId = paid.chatId || order.chatId;
        const nick =
            getBuyerSession(state, chatId, paid.buyerId).nick || order.nick || null;
        if (!nick) continue;

        order.nick = nick;
        console.log(
            `[sell] ${oid.slice(0, 8)}…: → ws ${nick} ${paid.amountKk}kk (очередь чата)`,
        );

        try {
            await dispatchOrder({
                ...order,
                ...paid,
                orderId: oid,
                nick,
                paidAtMs: Date.parse(paid.paidAt),
            });
            setOrderPhase(state, oid, 'dispatched', {
                nick,
                dispatchedAt: new Date().toISOString(),
            });
        } catch (e) {
            console.error(`[sell] ws ${oid}: ${e.message}`);
            setOrderPhase(state, oid, 'awaiting_nick', {
                nick,
                lastError: e.message,
            });
        }
    }
}

export function registerDealOrders(state, deals, cutoffIso = null) {
    for (const paid of deals) {
        const oid = paid.dealId;
        const prev = getOrder(state, oid);
        if (prev) continue;

        if (isStaleDeal(paid, cutoffIso)) {
            upsertOrder(state, {
                ...paid,
                orderId: oid,
                chatId: paid.chatId,
                anarchy: DELIVERY_ANARCHY(),
                phase: 'legacy',
            });
            console.log(
                `[sell] старый заказ (игнор): ${oid.slice(0, 8)}… | ${paid.buyer} | ${paid.amountKk}kk`,
            );
            continue;
        }

        upsertOrder(state, {
            ...paid,
            orderId: oid,
            chatId: paid.chatId,
            anarchy: DELIVERY_ANARCHY(),
            phase: 'new',
        });
        console.log(
            `[sell] заказ ${oid.slice(0, 8)}…: ${paid.itemName} | ${paid.buyer} | ${paid.amountKk}kk`,
        );
    }
}

export function filterActionableDeals(state, deals) {
    return deals.filter((d) => isActionableOrder(getOrder(state, d.dealId)));
}
