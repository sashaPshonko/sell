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
import {
    hasGreetingInChat,
    buildOrderCancelledHint,
    buildDispatchingHint,
    buildOrderAlreadyDoneHint,
    buildOrderClosedOnPlayerokHint,
} from './messages.mjs';
import { sendGreeting, sendChatMessage } from './chat.mjs';
import { dispatchOrder, dispatchNickUpdate, dispatchCancelOrder } from './dispatch.mjs';
import { applyOrderPayBonus } from './lib/pay-bonus.mjs';
import { cancelDealOnPlayerok } from './cancel.mjs';
import { DELIVERY_ANARCHY } from './messages.mjs';
import { isStaleDeal, isActionableOrder } from './lib/deal-cutoff.mjs';
import {
    playerokNeedsDelivery,
    playerokIsCancelled,
    playerokIsClosed,
    canDispatchToSellbot,
} from './lib/playerok-deal-sync.mjs';

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

    const nickParseOpts = { allowNikPhrase: !session.nick };
    const latest = findLatestBuyerNick(messages, buyerId, after, nickParseOpts);
    const first = parseBuyerNick(messages, buyerId, after, nickParseOpts);
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
export async function applyNickCommandUpdates(
    state,
    chatId,
    messages,
    buyerId,
    greetingAtIso,
    knownIds,
    client = null,
) {
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

        let queuedForDelivery = false;
        const buyerOrders = ordersInChat(state, chatId).filter((o) => o.buyerId === buyerId);

        for (const order of buyerOrders) {
            order.nick = u.nick;

            if (!canDispatchToSellbot(order)) {
                continue;
            }

            order.wrongNickWarned = false;

            if (order.phase === 'dispatched') {
                if (changed) {
                    await dispatchNickUpdate(order.orderId, u.nick);
                } else {
                    setOrderPhase(state, order.orderId, 'awaiting_nick', {
                        nick: u.nick,
                        lastError: null,
                    });
                    queuedForDelivery = true;
                }
                continue;
            }

            if (!isActionableOrder(order)) {
                continue;
            }

            setOrderPhase(state, order.orderId, 'awaiting_nick', {
                nick: u.nick,
                lastError: null,
            });
            queuedForDelivery = true;
        }

        if (!queuedForDelivery && client) {
            const closed = buyerOrders.find(
                (o) =>
                    o.phase === 'completed'
                    || o.gameDeliveryAt
                    || (o.playerokStatus && playerokIsClosed(o.playerokStatus)),
            );
            if (closed) {
                const hint = closed.gameDeliveryAt
                    ? buildOrderAlreadyDoneHint()
                    : buildOrderClosedOnPlayerokHint();
                try {
                    await sendChatMessage(client, chatId, hint);
                    console.log(
                        `[sell] ${closed.orderId.slice(0, 8)}…: /nick после закрытия (playerok=${closed.playerokStatus || '?'})`,
                    );
                } catch (e) {
                    console.warn(`[sell] ответ в чат: ${e.message}`);
                }
            } else {
                console.warn(
                    `[sell] ник ${u.nick} — нечего выдавать (заказы: ${
                        buyerOrders
                            .map((o) => `${o.orderId?.slice(0, 8)}… ${o.phase}`)
                            .join(', ') || 'нет'
                    })`,
                );
            }
        }
    }
    return known;
}

/** Одно сообщение — только для этого заказа (не для всех открытых в чате). */
async function notifyDispatchingForOrder(client, state, chatId, order, nick) {
    if (!order || order.dispatchAckSentAt) return;
    if (!isActionableOrder(order)) return;
    if (order.playerokStatus && !playerokNeedsDelivery(order.playerokStatus)) return;

    try {
        await sendChatMessage(
            client,
            chatId,
            buildDispatchingHint(nick, order.amountKk, order.payAmountKk),
        );
        setOrderPhase(state, order.orderId, order.phase, {
            dispatchAckSentAt: new Date().toISOString(),
        });
    } catch (e) {
        console.warn(`[sell] «сейчас выдаю»: ${e.message}`);
    }
}

/** Все незавершённые заказы чата → sellbot, строго по времени оплаты */
export async function flushChatDispatchQueue(state, deals, client = null) {
    const sorted = [...deals].sort((a, b) => Date.parse(a.paidAt) - Date.parse(b.paidAt));

    for (const paid of sorted) {
        const oid = paid.dealId;
        const order = getOrder(state, oid);
        if (!order) continue;
        if (!canDispatchToSellbot(order)) {
            continue;
        }
        if (order.phase === 'dispatched') {
            continue;
        }

        const chatId = paid.chatId || order.chatId;
        const nick =
            getBuyerSession(state, chatId, paid.buyerId).nick || order.nick || null;
        if (!nick) continue;

        order.nick = nick;
        applyOrderPayBonus(state, order);

        if (client) {
            await notifyDispatchingForOrder(client, state, chatId, order, nick);
        }

        try {
            const fresh = getOrder(state, oid) || order;
            const { sent } = await dispatchOrder(
                {
                    ...fresh,
                    ...paid,
                    orderId: oid,
                    nick,
                    paidAtMs: Date.parse(paid.paidAt),
                },
                state,
            );
            if (sent > 0) {
                const payKk = fresh.payAmountKk ?? paid.amountKk;
                console.log(
                    `[sell] ${oid}: → sellbot ${nick} ${payKk}kk (лот ${paid.amountKk}kk)`,
                );
                setOrderPhase(state, oid, 'dispatched', {
                    nick,
                    dispatchedAt: new Date().toISOString(),
                });
            } else {
                const payKk = fresh.payAmountKk ?? paid.amountKk;
                console.warn(
                    `[sell] ${oid}: sellbot офлайн — ${nick} ${payKk}kk (ждём ws)`,
                );
                setOrderPhase(state, oid, 'ws_pending', {
                    nick,
                    lastError: 'sellbot_offline',
                });
            }
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
    const newlyRegistered = [];
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
                playerokStatus: paid.status,
                playerokStatusAt: paid.paidAt,
            });
            console.log(
                `[sell] старый заказ (игнор): ${oid.slice(0, 8)}… | ${paid.buyer} | ${paid.amountKk}kk`,
            );
            continue;
        }

        let phase = 'new';
        if (playerokIsCancelled(paid.status)) {
            phase = 'cancelled';
        } else if (playerokIsClosed(paid.status)) {
            phase = 'completed';
        } else if (!playerokNeedsDelivery(paid.status)) {
            phase = 'completed';
        }

        upsertOrder(state, {
            ...paid,
            orderId: oid,
            chatId: paid.chatId,
            anarchy: DELIVERY_ANARCHY(),
            phase,
            playerokStatus: paid.status,
            playerokStatusAt: paid.paidAt,
        });
        console.log(
            `[sell] заказ ${oid.slice(0, 8)}…: ${paid.itemName} | ${paid.buyer} | ${paid.amountKk}kk`,
        );
        newlyRegistered.push(state.orders[oid]);
    }
    return newlyRegistered;
}

export function filterActionableDeals(state, deals) {
    return deals.filter((d) => isActionableOrder(getOrder(state, d.dealId)));
}

/** Оплаты из чата + открытые заказы из state (если ITEM_PAID выпал из ленты). */
export function mergeChatDeals(state, chatId, dealsFromMessages) {
    const byId = new Map();
    for (const d of dealsFromMessages) {
        byId.set(d.dealId, d);
    }
    for (const order of ordersInChat(state, chatId)) {
        if (!isActionableOrder(order)) continue;
        const id = order.orderId || order.dealId;
        if (!id || byId.has(id)) continue;
        byId.set(id, {
            dealId: id,
            chatId,
            buyerId: order.buyerId,
            buyer: order.buyer,
            amountKk: order.amountKk,
            status: order.playerokStatus,
            paidAt: order.paidAt,
            itemId: order.itemId,
            itemName: order.itemName,
            server: order.server,
        });
    }
    return [...byId.values()].sort((a, b) => Date.parse(a.paidAt) - Date.parse(b.paidAt));
}

export function chatHasOpenOrders(state, chatId) {
    return ordersInChat(state, chatId).some((o) => isActionableOrder(o));
}

/** Повторная отправка в sellbot после переподключения ws */
export async function retryWsPendingOrders(state) {
    for (const order of Object.values(state.orders)) {
        if (order.phase !== 'ws_pending' || !order.nick) continue;
        const oid = order.orderId || order.dealId;
        if (!canDispatchToSellbot(order)) {
            console.log(
                `[sell] ${oid.slice(0, 8)}…: ws_pending пропуск (phase=${order.phase}, game=${order.gameDeliveryAt ? 'ok' : 'нет'})`,
            );
            continue;
        }
        applyOrderPayBonus(state, order);
        try {
            const fresh = getOrder(state, oid) || order;
            const { sent } = await dispatchOrder(
                {
                    ...fresh,
                    orderId: oid,
                    dealId: oid,
                    chatId: order.chatId,
                    buyer: order.buyer,
                    buyerId: order.buyerId,
                    nick: order.nick,
                    amountKk: fresh.amountKk ?? order.amountKk,
                    paidAt: order.paidAt,
                    paidAtMs: order.paidAt ? Date.parse(order.paidAt) : undefined,
                    itemName: order.itemName,
                    server: order.server,
                },
                state,
            );
            if (sent > 0) {
                const payKk = fresh.payAmountKk ?? order.amountKk;
                console.log(`[sell] ${oid}: → sellbot (повтор ws) ${order.nick} ${payKk}kk`);
                setOrderPhase(state, oid, 'dispatched', {
                    nick: order.nick,
                    dispatchedAt: new Date().toISOString(),
                    lastError: null,
                });
            }
        } catch (e) {
            console.warn(`[sell] ws повтор ${oid}: ${e.message}`);
        }
    }
}
