import {
    parseBuyerNick,
    parseBuyerNickIntakes,
    findLatestBuyerNick,
    findGreetingAnchorInChat,
    isCancelCommand,
    sameUserId,
    isBuyerUser,
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
    buildNewOrderTwinHint,
    buildOrderCancelledHint,
    buildOrderCancelDeniedHint,
    buildDispatchingHint,
    buildNickDeliveryActiveHint,
    buildNickQueueWaitingHint,
    buildPremiumRefundUpsellHint,
    buildClanWithdrawWaitHint,
    buildDeliveryAttemptsExceededHint,
    clanFullAmountRaw,
} from './messages.mjs';
import {
    resolveProfileUpsell,
    profileUpsellEmoji,
    isMarkedProfileLot,
} from './lib/profile-upsell.mjs';
import { getQueuePosition } from './lib/delivery-queue.mjs';
import { sendGreeting, sendChatMessage } from './chat.mjs';
import { dispatchOrder, dispatchNickUpdate, dispatchCancelOrder } from './dispatch.mjs';
import { applyOrderPayBonus, buyerEligibleForRepeatBonus } from './lib/pay-bonus.mjs';
import { isBuyerBanned } from './lib/banlist.mjs';
import { cancelDealOnPlayerok } from './cancel.mjs';
import { isBuyerOrderCancelBlocked } from './lib/order-cancel.mjs';
import { DELIVERY_ANARCHY } from './messages.mjs';
import { isStaleDeal, isActionableOrder } from './lib/deal-cutoff.mjs';
import {
    playerokNeedsDelivery,
    playerokIsCancelled,
    playerokIsClosed,
    resolveDealStatus,
    dealNeedsFulfillment,
    canDispatchToSellbot,
    shouldIgnoreNickRedispatch,
    clanDeliveryRetryReset,
    buyerHasPendingOrder,
    isOrderFulfilled,
    isDeliveryAttemptsExhausted,
    MAX_DELIVERY_ATTEMPTS,
} from './lib/playerok-deal-sync.mjs';

/**
 * Синхронизирует ник покупателя на весь чат (все его заказы).
 * @returns {string|null}
 */
/** Не раньше nickResetAt (новая оплата) или приветствия — старые /nick из чата не трогаем. */
function nickMessagesAfter(session, greetingAtIso) {
    if (session.nickResetAt) return session.nickResetAt;
    return greetingAtIso || null;
}

function resolveBuyerUsername(state, chatId, buyerId) {
    for (const order of ordersInChat(state, chatId)) {
        if (sameUserId(order.buyerId, buyerId) && order.buyer) {
            return order.buyer;
        }
    }
    return null;
}

/** /cancel — по-прежнему не трогаем старые команды до nickResetAt / приветствия. */
function cancelMessagesAfter(session, greetingAtIso) {
    if (session.nickResetAt) return session.nickResetAt;
    return greetingAtIso || null;
}

export function syncChatNick(
    state,
    chatId,
    messages,
    buyerId,
    greetingAtIso,
    sellerUserId = null,
    sellerUsername = null,
) {
    const session = getBuyerSession(state, chatId, buyerId);
    const after = nickMessagesAfter(session, greetingAtIso);
    const buyerUsername = resolveBuyerUsername(state, chatId, buyerId);

    const nickParseOpts = {
        allowNikPhrase: true,
        sellerUserId,
        sellerUsername,
        buyerUsername,
    };
    const latest = findLatestBuyerNick(messages, buyerId, after, nickParseOpts);
    const first = parseBuyerNick(messages, buyerId, after, nickParseOpts);
    const pick = latest?.via === 'command' ? latest : first || latest;

    if (pick?.nick) {
        session.nick = pick.nick;
        session.via = pick.via;
        session.messageId = pick.messageId;
        session.nickAt = pick.at;
        for (const order of ordersInChat(state, chatId)) {
            if (order.buyerId !== buyerId) continue;
            if (order.phase === 'completed' || order.phase === 'cancelled') continue;
            order.nick = pick.nick;
            if (isActionableOrder(order) && order.phase === 'new') {
                setOrderPhase(state, order.orderId, 'awaiting_nick', { nick: pick.nick });
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
        for (const paid of deals) {
            const o = getOrder(state, paid.dealId);
            if (!o || !isActionableOrder(o)) continue;
            if (o.phase === 'new') {
                setOrderPhase(state, paid.dealId, 'awaiting_nick', {
                    greetedAt: chat.greetingAt,
                });
            }
        }
        return chat.greetingAt;
    }

    const firstDeal = deals[0];
    await sendGreeting(client, chatId, {
        orderId: firstDeal?.dealId,
        lotKk: firstDeal?.amountKk,
        repeatEligible: buyerEligibleForRepeatBonus(state, firstDeal?.buyerId),
    });
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
 * Лот без 🎁 — если на профиле есть 🎁-аналог (больше kk, те же ₽):
 * отмена на PlayerOK + ссылка. Без успешного автовозврата — обычная выдача.
 * @param {object[]} newOrders — заказы из registerDealOrders
 */
export async function sendPremiumRefundUpsellForOrders(client, state, chatId, newOrders) {
    if (!client || !newOrders?.length) return;
    if (process.env.PREMIUM_REFUND_UPSELL === '0') return;

    const sellerUserId = state.sellerUserId;
    const sellerUsername = state.sellerUsername ?? null;
    const messagedBuyers = new Set();

    for (const order of newOrders) {
        if (!order || !isActionableOrder(order)) continue;
        if (!playerokNeedsDelivery(order.playerokStatus)) continue;
        if (order.premiumRefundUpsellSentAt) continue;
        if (isMarkedProfileLot(order.itemName)) continue;
        if (isBuyerBanned(state, order.buyerId)) continue;

        let match = null;
        if (sellerUserId) {
            try {
                match = await resolveProfileUpsell(
                    client,
                    order,
                    sellerUserId,
                    sellerUsername,
                );
            } catch (e) {
                console.warn(`[sell] profile-upsell refund: ${e.message}`);
            }
        }

        const baseKk = Math.round(Number(order.amountKk) || 0);
        const upsellKk = Math.round(Number(match?.kk) || 0);
        if (!match?.url || upsellKk <= baseKk || baseKk <= 0) {
            continue;
        }

        if (process.env.AUTO_CANCEL_PLAYEROK !== '1') {
            console.log(
                `[sell] profile-upsell ${order.orderId.slice(0, 8)}…: аналог ${upsellKk}кк, нет AUTO_CANCEL — выдача`,
            );
            continue;
        }

        try {
            await cancelDealOnPlayerok(client, order.orderId);
        } catch (e) {
            console.warn(
                `[sell] profile-upsell PlayerOK ${order.orderId.slice(0, 8)}…: ${e.message} — выдача`,
            );
            continue;
        }

        const wasDispatched = order.phase === 'dispatched';
        setOrderPhase(state, order.orderId, 'cancelled', {
            cancelledAt: new Date().toISOString(),
            cancelReason: 'profile_upsell_refund',
            premiumRefundUpsellSentAt: new Date().toISOString(),
            playerokCancelledAt: new Date().toISOString(),
        });
        if (wasDispatched) {
            await dispatchCancelOrder(order.orderId, state);
        }

        console.log(
            `[sell] profile-upsell refund ${order.orderId.slice(0, 8)}… → ${upsellKk}кк (было ${baseKk}кк)`,
        );

        if (order.buyerId && messagedBuyers.has(order.buyerId)) {
            continue;
        }
        if (order.buyerId) messagedBuyers.add(order.buyerId);

        try {
            await sendChatMessage(
                client,
                chatId,
                buildPremiumRefundUpsellHint({
                    upsellKk,
                    url: match.url,
                    emoji: match.emoji ?? profileUpsellEmoji(),
                }),
            );
        } catch (e) {
            console.warn(`[sell] profile-upsell refund чат: ${e.message}`);
        }
    }
}

/**
 * Новые оплаты, когда полное приветствие в чате уже было — коротко про твинк.
 * @param {object[]} newOrders — заказы из registerDealOrders
 */
export async function sendTwinRemindersForNewOrders(client, state, chatId, newOrders) {
    if (!newOrders?.length) return;

    const chat = ensureChat(state, chatId);
    const twinSentForBuyer = new Set();

    for (const order of newOrders) {
        if (!order || !isActionableOrder(order)) continue;
        if (!playerokNeedsDelivery(order.playerokStatus)) continue;
        if (order.twinReminderSentAt) continue;
        if (order.buyerId && twinSentForBuyer.has(order.buyerId)) {
            setOrderPhase(state, order.orderId, order.phase, {
                twinReminderSentAt: new Date().toISOString(),
                greetedAt: order.greetedAt || chat.greetingAt,
            });
            continue;
        }

        const phase = order.phase === 'new' ? 'awaiting_nick' : order.phase;
        setOrderPhase(state, order.orderId, phase, {
            twinReminderSentAt: new Date().toISOString(),
            greetedAt: order.greetedAt || chat.greetingAt,
        });
        if (order.buyerId) twinSentForBuyer.add(order.buyerId);

        try {
            await sendChatMessage(
                client,
                chatId,
                buildNewOrderTwinHint({
                    lotKk: order.amountKk,
                    repeatEligible: buyerEligibleForRepeatBonus(state, order.buyerId),
                }),
            );
            console.log(
                `[sell] чат ${chatId.slice(0, 8)}…: напоминание твинк (заказ ${order.orderId.slice(0, 8)}…)`,
            );
        } catch (e) {
            console.warn(`[sell] напоминание твинк: ${e.message}`);
        }
    }
}

/**
 * /cancel — отменить незавершённые заказы покупателя, оплаченные не позже этого /cancel.
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
    const session = getBuyerSession(state, chatId, buyerId);
    const buyerUsername = resolveBuyerUsername(state, chatId, buyerId);
    const afterIso = cancelMessagesAfter(session, greetingAtIso);
    const after = afterIso ? Date.parse(afterIso) : 0;
    let replied = false;

    for (const msg of messages) {
        if (!msg?.text || msg.deal) continue;
        if (!isBuyerUser(msg, buyerId, buyerUsername)) continue;
        const msgAt = Date.parse(msg.createdAt);
        if (isCancelCommand(msg.text) && after && msgAt < after) {
            known.add(msg.id);
            continue;
        }
        if (known.has(msg.id)) continue;
        if (!isCancelCommand(msg.text)) continue;

        known.add(msg.id);

        let cancelled = 0;
        let blocked = 0;
        let playerokCancelled = 0;
        for (const order of ordersInChat(state, chatId)) {
            if (order.buyerId !== buyerId) continue;
            if (order.phase === 'completed' || order.phase === 'cancelled') continue;
            const paidAtMs = order.paidAt ? Date.parse(order.paidAt) : 0;
            if (paidAtMs > msgAt) continue;

            if (isBuyerOrderCancelBlocked(order)) {
                blocked += 1;
                console.log(
                    `[sell] /cancel отклонён: деньги в казне ${order.orderId.slice(0, 8)}…`,
                );
                continue;
            }

            const wasDispatched = order.phase === 'dispatched';
            setOrderPhase(state, order.orderId, 'cancelled', {
                cancelledAt: new Date().toISOString(),
            });
            if (wasDispatched) {
                await dispatchCancelOrder(order.orderId, state);
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

        if (cancelled > 0 && !replied) {
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
        } else if (blocked > 0 && !replied) {
            try {
                await sendChatMessage(client, chatId, buildOrderCancelDeniedHint());
            } catch (e) {
                console.warn(`[sell] отмена запрещена, ответ в чат: ${e.message}`);
            }
            replied = true;
        } else if (!cancelled && !blocked) {
            console.log(`[sell] /cancel: нечего отменять (чат ${chatId.slice(0, 8)}…)`);
        }
    }
    return known;
}

/**
 * Новый /nick — обновить сессию и перезапустить выдачу у dispatched (если завис).
 */
function clanRemainAmount(order) {
    const full = Number(clanFullAmountRaw(order));
    const withdrawn = Math.max(
        Number(order.clanRemainderHintWithdrawn || 0),
        Number(order.clanPlayerWithdrawn || 0),
    );
    return Math.max(0, full - withdrawn);
}

async function notifyClanWithdrawWaitHint(client, state, chatId, order, nick) {
    if (!client || !order || order.clanWithdrawNickHintSentAt) return;
    if (!order.clanWithdrawHintSentAt && !order.clanRemainderHintSentAt) return;

    const remain = clanRemainAmount(order);
    if (remain <= 0) return;

    try {
        await sendChatMessage(client, chatId, buildClanWithdrawWaitHint(nick, remain));
        setOrderPhase(state, order.orderId, order.phase, {
            clanWithdrawNickHintSentAt: new Date().toISOString(),
        });
    } catch (e) {
        console.warn(`[sell] clan withdraw wait hint: ${e.message}`);
    }
}

export async function applyNickCommandUpdates(
    state,
    chatId,
    messages,
    buyerId,
    greetingAtIso,
    knownIds,
    client = null,
    sellerUserId = null,
    sellerUsername = null,
    sellerKnownIds = null,
) {
    const session = getBuyerSession(state, chatId, buyerId);
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
    const sellerKnown = sellerKnownIds instanceof Set
        ? sellerKnownIds
        : new Set(sellerKnownIds || []);
    const after = nickMessagesAfter(session, greetingAtIso);
    const buyerUsername = resolveBuyerUsername(state, chatId, buyerId);
    const nickParseOpts = {
        allowNikPhrase: true,
        sellerUserId,
        sellerUsername,
        buyerUsername,
        sellerKnownIds: sellerKnown,
    };
    let updates = parseBuyerNickIntakes(messages, buyerId, after, known, nickParseOpts);

    // Один раз на сообщение /nick: если уже отрабатывали — не повторяем на каждом poll.
    updates = updates.filter((u) => u.messageId && u.messageId !== session.appliedNickMessageId);

    if (!updates.length) {
        const buyerOrders = ordersInChat(state, chatId).filter((o) => o.buyerId === buyerId);
        const latest = findLatestBuyerNick(messages, buyerId, after, nickParseOpts);
        if (
            latest?.nick
            && latest.messageId
            && latest.messageId !== session.appliedNickMessageId
        ) {
            const needsWork = buyerOrders.some((o) => {
                if (isOrderFulfilled(o)) return false;
                // После сбоя ждём новый /nick в чате
                if (o.pausedUntilNick) return true;
                // dispatched / ws_pending — ждём sellbot / retryWsPendingOrders
                if (o.phase === 'dispatched' || o.phase === 'ws_pending') return false;
                return isActionableOrder(o) && canDispatchToSellbot(o);
            });
            if (needsWork) {
                updates = [{ ...latest }];
            }
        }
    }

    for (const u of updates) {
        const priorMessageId = session.messageId;
        const isNewNickMessage = Boolean(u.messageId && u.messageId !== priorMessageId);
        const changed = session.nick !== u.nick;

        const who = u.fromSeller ? ' (продавец)' : '';
        console.log(`[sell] чат ${chatId.slice(0, 8)}…: ник → ${u.nick}${who}`);

        let queuedForDelivery = false;
        let nickApplied = false;
        let blockedByActiveDelivery = false;
        const buyerOrders = ordersInChat(state, chatId).filter((o) => o.buyerId === buyerId);

        for (const order of buyerOrders) {
            if (shouldIgnoreNickRedispatch(order)) {
                const fulfilled = isOrderFulfilled(order);
                console.log(
                    `[sell] повторный ник игнор: ${order.orderId?.slice(0, 8)}… (${fulfilled ? 'заказ закрыт' : 'выдача идёт'})`,
                );
                if (!fulfilled) {
                    order.queueStatusSentAt = undefined;
                    if (
                        !order.pausedUntilNick
                        && (order.phase === 'dispatched' || order.phase === 'ws_pending')
                    ) {
                        blockedByActiveDelivery = true;
                    }
                }
                continue;
            }

            if (order.clanJoinedAt && order.nick && order.nick !== u.nick) {
                console.log(
                    `[sell] чат ${chatId.slice(0, 8)}…: новый ник игнор — ${order.nick} уже в клане`,
                );
                continue;
            }

            const wasPausedUntilNick = order.pausedUntilNick;
            order.nick = u.nick;
            order.pausedUntilNick = false;
            order.deliveryHintSentAt = undefined;
            order.queueStatusSentAt = undefined;
            if (isNewNickMessage) {
                order.deliveryAttempts = 0;
                order.deliveryAttemptsHintSentAt = undefined;
            }
            nickApplied = true;

            if (order.phase === 'dispatched') {
                order.wrongNickWarned = false;
                if (changed) {
                    await dispatchNickUpdate(order.orderId, u.nick);
                } else if (isNewNickMessage || u.recovery || wasPausedUntilNick) {
                    setOrderPhase(
                        state,
                        order.orderId,
                        'awaiting_nick',
                        clanDeliveryRetryReset({
                            nick: u.nick,
                            lastError: null,
                            ...(u.recovery
                                ? { nickRecoveryForMessageId: u.messageId }
                                : {}),
                        }),
                    );
                    queuedForDelivery = true;
                }
                continue;
            }

            if (!canDispatchToSellbot(order)) {
                continue;
            }

            order.wrongNickWarned = false;

            if (!isActionableOrder(order)) {
                continue;
            }

            setOrderPhase(
                state,
                order.orderId,
                'awaiting_nick',
                clanDeliveryRetryReset({
                    nick: u.nick,
                    lastError: null,
                }),
            );
            queuedForDelivery = true;
        }

        if (nickApplied) {
            if (u.fromSeller) {
                sellerKnown.add(u.messageId);
            } else {
                known.add(u.messageId);
            }
            session.appliedNickMessageId = u.messageId;
            session.nick = u.nick;
            session.via = u.via;
            session.messageId = u.messageId;
            session.nickAt = u.at;
        } else if (blockedByActiveDelivery && client) {
            const active = buyerOrders.find(
                (o) =>
                    !isOrderFulfilled(o)
                    && shouldIgnoreNickRedispatch(o)
                    && !o.pausedUntilNick,
            );
            if (active) {
                await notifyClanWithdrawWaitHint(client, state, chatId, active, u.nick);
            }
        }

        if (!queuedForDelivery && client && nickApplied) {
            if (buyerHasPendingOrder(state, chatId, buyerId)) {
                console.log(
                    `[sell] ник ${u.nick} (${u.via}) — открытый заказ, выдачу ждём flush (${
                        buyerOrders
                            .filter((o) => !isOrderFulfilled(o))
                            .map((o) => `${o.orderId?.slice(0, 8)}… ${o.phase}`)
                            .join(', ') || '?'
                    })`,
                );
            } else if (u.via === 'command') {
                console.warn(
                    `[sell] /nick ${u.nick} — нечего выдавать (заказы: ${
                        buyerOrders
                            .map((o) => `${o.orderId?.slice(0, 8)}… ${o.phase}`)
                            .join(', ') || 'нет'
                    })`,
                );
            }
        }
    }
    return { known, sellerKnown };
}

function buildQueueStatusMessage(state, order, nick) {
    const payKk = order.payAmountKk ?? order.amountKk;
    const q = getQueuePosition(order.orderId, state);
    if (q.isActive) {
        return buildDispatchingHint(nick, order.amountKk, {
            lotKk: order.amountKk,
            payAmountKk: order.payAmountKk,
            wheelPct: order.bonusWheelPct,
            repeatPct: order.bonusRepeatPct,
            bonusWheelKk: order.bonusWheelKk,
            bonusRepeatKk: order.bonusRepeatKk,
        });
    }
    if (q.inQueue && q.position > 1) {
        return buildNickQueueWaitingHint(q.position, payKk);
    }
    return buildNickDeliveryActiveHint(nick, payKk);
}

/** Статус очереди — /nick или перед dispatch */
async function notifyDeliveryQueueStatus(client, state, chatId, order, nick) {
    if (!client || !order || order.queueStatusSentAt) return;
    if (!isActionableOrder(order) && order.phase !== 'dispatched' && order.phase !== 'ws_pending') {
        return;
    }
    if (order.playerokStatus && !playerokNeedsDelivery(order.playerokStatus)) return;

    try {
        await sendChatMessage(client, chatId, buildQueueStatusMessage(state, order, nick));
        setOrderPhase(state, order.orderId, order.phase, {
            queueStatusSentAt: new Date().toISOString(),
        });
    } catch (e) {
        console.warn(`[sell] очередь: ${e.message}`);
    }
}

/** Одно сообщение — только для этого заказа (не для всех открытых в чате). */
async function notifyDispatchingForOrder(client, state, chatId, order, nick) {
    if (!order || order.dispatchAckSentAt) return;
    if (!isActionableOrder(order)) return;
    if (order.playerokStatus && !playerokNeedsDelivery(order.playerokStatus)) return;

    await notifyDeliveryQueueStatus(client, state, chatId, order, nick);
    if (!getOrder(state, order.orderId)?.queueStatusSentAt) return;

    setOrderPhase(state, order.orderId, order.phase, {
        dispatchAckSentAt: new Date().toISOString(),
    });
}

/** Все незавершённые заказы чата → sellbot, строго по времени оплаты */
export async function flushChatDispatchQueue(state, deals, client = null) {
    const sorted = [...deals].sort((a, b) => Date.parse(a.paidAt) - Date.parse(b.paidAt));

    for (const paid of sorted) {
        const oid = paid.dealId;
        const order = getOrder(state, oid);
        if (!order) continue;
        if (!canDispatchToSellbot(order)) {
            if (isDeliveryAttemptsExhausted(order)) {
                const chatId = paid.chatId || order.chatId;
                if (client && !order.deliveryAttemptsHintSentAt) {
                    await sendChatMessage(
                        client,
                        chatId,
                        buildDeliveryAttemptsExceededHint(MAX_DELIVERY_ATTEMPTS),
                    );
                    setOrderPhase(state, oid, order.phase, {
                        deliveryAttemptsHintSentAt: new Date().toISOString(),
                        pausedUntilNick: true,
                    });
                    void dispatchCancelOrder(oid, state);
                }
            }
            continue;
        }
        if (order.phase === 'dispatched') {
            continue;
        }

        const chatId = paid.chatId || order.chatId;
        const session = getBuyerSession(state, chatId, paid.buyerId);
        const nick = session.nick || order.nick || null;
        if (!nick) continue;
        const resetAt = session.nickResetAt ? Date.parse(session.nickResetAt) : 0;
        const nickAt = session.nickAt ? Date.parse(session.nickAt) : 0;
        if (resetAt && (!nickAt || nickAt < resetAt)) continue;

        order.nick = nick;
        applyOrderPayBonus(state, order);

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
                    `[sell] ${oid}: → sellbot ${nick} ${payKk}kk (лот ${paid.amountKk}kk, попытка ${(fresh.deliveryAttempts || 0) + 1}/${MAX_DELIVERY_ATTEMPTS})`,
                );
                setOrderPhase(state, oid, 'dispatched', {
                    nick,
                    dispatchedAt: new Date().toISOString(),
                    deliveryAttempts: (fresh.deliveryAttempts || 0) + 1,
                });
                if (client) {
                    await notifyDispatchingForOrder(
                        client,
                        state,
                        chatId,
                        getOrder(state, oid) || order,
                        nick,
                    );
                }
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

export function registerDealOrders(state, deals, cutoffIso = null, timeline = null) {
    const newlyRegistered = [];
    for (const paid of deals) {
        const oid = paid.dealId;
        const prev = getOrder(state, oid);
        if (prev) continue;

        const latestStatus = resolveDealStatus(timeline, oid, paid.status);
        const statusAt = timeline?.get?.(oid)?.at ?? paid.paidAt;

        if (isStaleDeal(paid, cutoffIso)) {
            upsertOrder(state, {
                ...paid,
                orderId: oid,
                chatId: paid.chatId,
                anarchy: DELIVERY_ANARCHY,
                phase: 'legacy',
                playerokStatus: latestStatus,
                playerokStatusAt: statusAt,
            });
            console.log(
                `[sell] старый заказ (игнор): ${oid.slice(0, 8)}… | ${paid.buyer} | ${paid.amountKk}kk`,
            );
            continue;
        }

        let phase = 'new';
        if (playerokIsCancelled(latestStatus)) {
            phase = 'cancelled';
        } else if (playerokIsClosed(latestStatus)) {
            phase = 'completed';
        } else if (!playerokNeedsDelivery(latestStatus)) {
            phase = 'completed';
        }

        upsertOrder(state, {
            ...paid,
            orderId: oid,
            chatId: paid.chatId,
            anarchy: DELIVERY_ANARCHY,
            phase,
            playerokStatus: latestStatus,
            playerokStatusAt: statusAt,
        });

        const needsOnboarding = phase !== 'completed' && phase !== 'cancelled';
        if (
            needsOnboarding
            && paid.chatId
            && paid.buyerId
            && paid.paidAt
        ) {
            const session = getBuyerSession(state, paid.chatId, paid.buyerId);
            session.nickResetAt = paid.paidAt;
            delete session.nick;
            delete session.via;
            delete session.messageId;
            delete session.nickAt;
            delete session.appliedNickMessageId;
        }

        console.log(
            `[sell] заказ ${oid.slice(0, 8)}…: ${paid.itemName} | ${paid.buyer} | ${paid.amountKk}kk (${latestStatus})`,
        );

        if (needsOnboarding && dealNeedsFulfillment(timeline, oid, latestStatus)) {
            newlyRegistered.push(state.orders[oid]);
        }
    }
    return newlyRegistered;
}

export function filterActionableDeals(state, deals) {
    return deals.filter((d) => isActionableOrder(getOrder(state, d.dealId)));
}

/** Оплаты из чата + открытые заказы из state (если ITEM_PAID выпал из ленты). */
export function mergeChatDeals(state, chatId, dealsFromMessages, timeline = null) {
    const byId = new Map();
    for (const d of dealsFromMessages) {
        const status = resolveDealStatus(timeline, d.dealId, d.status);
        if (timeline && !dealNeedsFulfillment(timeline, d.dealId, d.status)) {
            continue;
        }
        byId.set(d.dealId, { ...d, status });
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

/** Любой незакрытый заказ в чате (в т.ч. dispatched / ws_pending). */
export function chatHasPendingOrders(state, chatId) {
    return ordersInChat(state, chatId).some((o) => !isOrderFulfilled(o));
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
                    deliveryAttempts: (fresh.deliveryAttempts || 0) + 1,
                });
            }
        } catch (e) {
            console.warn(`[sell] ws повтор ${oid}: ${e.message}`);
        }
    }
}
