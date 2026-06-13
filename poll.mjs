import { loadEnv } from './lib/env.mjs';
import { audit } from './lib/audit.mjs';
import { createClient } from './playerok-client.mjs';
import {
    findAllCurrencyPaidDeals,
    findIgnoredPaidDeals,
    flattenChats,
    flattenMessages,
    parseBuyerNickUpdates,
    looksLikeInvalidNickAttempt,
    findGreetingAnchorInChat,
    isBuyerUser,
} from './parse.mjs';
import {
    loadState,
    saveState,
    getOrder,
    setOrderPhase,
    ordersInChat,
    getBuyerSession,
} from './state.mjs';
import { recordBuyerDelivery } from './lib/pay-bonus.mjs';
import {
    scheduleRepeatPromoMessage,
    flushScheduledChatMessages,
} from './lib/scheduled-chat.mjs';
import { drainBotEvents, dispatchCancelOrder } from './dispatch.mjs';
import { setDeliveryQueueSnapshot } from './lib/delivery-queue.mjs';
import { cancelClosedOrdersOnSellbot } from './lib/sellbot-cancel.mjs';
import { isOrderFulfilled, clanDeliveryRetryReset } from './lib/playerok-deal-sync.mjs';
import { sendChatMessage } from './chat.mjs';
import {
    buildWrongNickHint,
    buildDeliveryFailHint,
    buildQueueStallHint,
    buildDeliveryOkHint,
    buildClanInviteHint,
    buildClanWithdrawHint,
    buildClanRemainderHint,
    buildClanPartialWithdrawHint,
    clanFullAmountRaw,
    buildOrderAlreadyDoneHint,
    hasGreetingInChat,
    DELIVERY_ANARCHY,
} from './messages.mjs';
import { confirmDealOnPlayerok } from './confirm.mjs';
import { scheduleRepublishItem, republishWhen } from './publish.mjs';
import {
    registerDealOrders,
    filterActionableDeals,
    mergeChatDeals,
    chatHasOpenOrders,
    chatHasPendingOrders,
    ensureChatGreeting,
    sendTwinRemindersForNewOrders,
    sendPremiumRefundUpsellForOrders,
    syncChatNick,
    applyNickCommandUpdates,
    applyCancelCommands,
    flushChatDispatchQueue,
    retryWsPendingOrders,
} from './chat-session.mjs';
import {
    ensurePollStarted,
    getDealCutoffIso,
    migrateStaleOrders,
} from './lib/deal-cutoff.mjs';
import {
    applySellerBanCommands,
    rejectBannedBuyerOrdersInChat,
    isBuyerBanned,
} from './lib/banlist.mjs';
import {
    buildDealStatusTimeline,
    syncChatOrdersFromPlayerok,
    buyerHasPendingOrder,
} from './lib/playerok-deal-sync.mjs';
import {
    chatHasStuckOrders,
    fetchChatMessagesDeep,
    reconcileOrdersFromChatHistory,
} from './lib/chat-reconcile.mjs';
import { ensureChat } from './state.mjs';
import { assertPlayerokAuth } from './lib/check-auth.mjs';

loadEnv();

const once = process.argv.includes('--once');
const pollMs = Number(process.env.POLL_MS || 15000);

async function markPlayerokDone(client, state, dealId, chatId) {
    if (process.env.AUTO_MARK_PLAYEROK === '0') {
        scheduleRepeatPromoMessage(state, chatId, dealId);
        return;
    }
    try {
        await confirmDealOnPlayerok(client, dealId);
        setOrderPhase(state, dealId, 'completed', {
            playerokMarkedAt: new Date().toISOString(),
            playerokStatus: process.env.CONFIRM_DEAL_STATUS || 'SENT',
            playerokStatusAt: new Date().toISOString(),
        });
        console.log(`[sell] PlayerOK SENT: ${dealId}`);
        scheduleRepeatPromoMessage(state, chatId, dealId);
    } catch (e) {
        console.warn(`[sell] PlayerOK: ${e.message}`);
        scheduleRepeatPromoMessage(state, chatId, dealId);
    }
}

/** Не слать «повтори /nick», если выдача уже была или сделка закрыта на PlayerOK */
function shouldProcessBotRetryEvent(order) {
    if (!order) return false;
    return !isOrderFulfilled(order);
}

/** После сбоя — не крутить /pay и не дублировать подсказку, пока покупатель не пришлёт /nick снова */
function markDeliveryPaused(state, orderId, phase, extra = {}) {
    setOrderPhase(state, orderId, phase, {
        pausedUntilNick: true,
        ...extra,
    });
}

async function sendDeliveryHintOnce(client, state, chatId, orderId, order, buildHint) {
    if (order.deliveryHintSentAt) {
        console.log(
            `[sell] ${orderId.slice(0, 8)}…: подсказка уже отправлена, пропуск`,
        );
        return;
    }
    await sendChatMessage(client, chatId, buildHint());
    setOrderPhase(state, orderId, order.phase, {
        deliveryHintSentAt: new Date().toISOString(),
    });
}

async function handleBotEvents(client, state) {
    for (const ev of await drainBotEvents()) {
        if (ev.type === 'delivery_queue') {
            setDeliveryQueueSnapshot(ev);
            continue;
        }

        const order = getOrder(state, ev.orderId);
        if (!order) {
            console.warn(`[sell] ws: неизвестный заказ ${ev.orderId}`);
            continue;
        }
        const chatId = order.chatId;
        const buyerId = order.buyerId;

        try {
            if (ev.type === 'clan_invite_sent') {
                const fresh = getOrder(state, ev.orderId) || order;
                if (fresh.clanInviteHintSentAt) continue;
                const nick = ev.nick || fresh.nick || '?';
                await sendChatMessage(client, chatId, buildClanInviteHint(nick));
                setOrderPhase(state, ev.orderId, fresh.phase, {
                    clanInviteHintSentAt: new Date().toISOString(),
                });
                console.log(`[sell] clan invite hint → ${ev.orderId.slice(0, 8)}…`);
            } else if (ev.type === 'clan_joined') {
                setOrderPhase(state, ev.orderId, order.phase, {
                    clanJoinedAt: new Date().toISOString(),
                });
                console.log(`[sell] clan joined ${ev.orderId.slice(0, 8)}…`);
            } else if (ev.type === 'clan_invested') {
                const fresh = getOrder(state, ev.orderId) || order;
                if (fresh.clanWithdrawHintSentAt) continue;
                const nick = ev.nick || fresh.nick || '?';
                const withdrawAmount =
                    ev.withdrawAmount ||
                    ev.investAmount ||
                    ev.fullInvestAmount ||
                    clanFullAmountRaw(fresh);
                await sendChatMessage(
                    client,
                    chatId,
                    buildClanWithdrawHint(nick, withdrawAmount),
                );
                setOrderPhase(state, ev.orderId, fresh.phase, {
                    clanWithdrawHintSentAt: new Date().toISOString(),
                    clanRemainderHintSentAt: null,
                });
                console.log(`[sell] clan withdraw hint → ${ev.orderId.slice(0, 8)}…`);
            } else if (ev.type === 'clan_withdraw_partial') {
                const fresh = getOrder(state, ev.orderId) || order;
                const nick = ev.nick || fresh.nick || '?';
                const full = Number(ev.full || clanFullAmountRaw(fresh));
                const withdrawn = Number(ev.withdrawn || 0);
                const remain = Math.max(0, full - withdrawn);
                if (remain <= 0) continue;
                if (withdrawn <= Number(fresh.clanRemainderHintWithdrawn || 0)) continue;
                await sendChatMessage(
                    client,
                    chatId,
                    buildClanRemainderHint(nick, remain),
                );
                setOrderPhase(state, ev.orderId, fresh.phase, {
                    clanRemainderHintSentAt: new Date().toISOString(),
                    clanRemainderHintWithdrawn: withdrawn,
                    clanPlayerWithdrawn: Math.max(
                        fresh.clanPlayerWithdrawn || 0,
                        withdrawn,
                    ),
                });
                console.log(`[sell] clan remainder hint → ${ev.orderId.slice(0, 8)}…`);
            } else if (ev.type === 'delivery_ok') {
                const payKk = order.payAmountKk ?? order.amountKk;
                setOrderPhase(state, ev.orderId, 'completed', {
                    gameDeliveryAt: new Date().toISOString(),
                });
                recordBuyerDelivery(state, order.buyerId);
                void audit('delivery_ok', {
                    orderId: ev.orderId,
                    nick: order.nick,
                    amountKk: order.amountKk,
                    payAmountKk: payKk,
                    bonusTotalPct: order.bonusTotalPct,
                });
                await sendChatMessage(
                    client,
                    chatId,
                    buildDeliveryOkHint(order.amountKk, {
                        lotKk: order.amountKk,
                        payAmountKk: payKk,
                        wheelPct: order.bonusWheelPct,
                        repeatPct: order.bonusRepeatPct,
                        bonusWheelKk: order.bonusWheelKk,
                        bonusRepeatKk: order.bonusRepeatKk,
                        totalPct: order.bonusTotalPct,
                    }),
                );
                setOrderPhase(state, ev.orderId, 'completed', {
                    buyerNotifiedAt: new Date().toISOString(),
                });
                void dispatchCancelOrder(ev.orderId);
                await markPlayerokDone(client, state, ev.orderId, chatId);
                if (republishWhen() === 'sent') {
                    scheduleRepublishItem(client, state, order);
                }
                console.log(
                    `[sell] выдано: ${ev.orderId} (${payKk}kk, лот ${order.amountKk}kk)`,
                );
            } else if (ev.type === 'delivery_stalled') {
                if (!shouldProcessBotRetryEvent(order)) {
                    console.log(
                        `[sell] stall ${ev.orderId.slice(0, 8)}… игнор (заказ уже закрыт)`,
                    );
                    continue;
                }
                const nick =
                    getBuyerSession(state, chatId, buyerId).nick || order.nick;
                const withdrawn = Number(ev.playerWithdrawn || 0);
                const fullAmount = Number(clanFullAmountRaw(order));
                const remain = Math.max(0, fullAmount - withdrawn);
                const partialWithdraw =
                    ev.reason === 'clan_withdraw_timeout' &&
                    withdrawn > 0 &&
                    remain > 0;
                markDeliveryPaused(
                    state,
                    ev.orderId,
                    'awaiting_nick',
                    clanDeliveryRetryReset({
                        lastError: 'stall_queue',
                        nick,
                        ...(withdrawn > 0
                            ? {
                                  clanPlayerWithdrawn: Math.max(
                                      order.clanPlayerWithdrawn || 0,
                                      withdrawn,
                                  ),
                              }
                            : {}),
                    }),
                );
                void dispatchCancelOrder(ev.orderId);
                if (partialWithdraw) {
                    await sendChatMessage(
                        client,
                        chatId,
                        buildClanPartialWithdrawHint(nick, remain),
                    );
                    setOrderPhase(state, ev.orderId, order.phase, {
                        deliveryHintSentAt: new Date().toISOString(),
                    });
                } else {
                    await sendDeliveryHintOnce(
                        client,
                        state,
                        chatId,
                        ev.orderId,
                        getOrder(state, ev.orderId) || order,
                        buildQueueStallHint,
                    );
                }
                console.warn(`[sell] stall ${ev.orderId} (очередь ${ev.queued ?? '?'})`);
            } else if (ev.type === 'delivery_failed') {
                if (!shouldProcessBotRetryEvent(order)) {
                    console.log(
                        `[sell] fail ${ev.orderId.slice(0, 8)}… игнор (заказ уже закрыт): ${ev.reason || '?'}`,
                    );
                    continue;
                }
                const reason = ev.reason || 'failed';
                if (reason === 'invalid' || reason === 'invalid_nick') {
                    const session = getBuyerSession(state, chatId, buyerId);
                    delete session.nick;
                    markDeliveryPaused(state, ev.orderId, 'awaiting_nick', {
                        lastError: 'invalid_nick',
                        nick: null,
                    });
                    void dispatchCancelOrder(ev.orderId);
                    await sendDeliveryHintOnce(
                        client,
                        state,
                        chatId,
                        ev.orderId,
                        getOrder(state, ev.orderId) || order,
                        buildWrongNickHint,
                    );
                    console.warn(`[sell] invalid_nick ${ev.orderId} (via delivery_failed)`);
                    continue;
                }
                const nick =
                    getBuyerSession(state, chatId, buyerId).nick || order.nick;
                markDeliveryPaused(
                    state,
                    ev.orderId,
                    'awaiting_nick',
                    clanDeliveryRetryReset({ lastError: reason, nick }),
                );
                void dispatchCancelOrder(ev.orderId);
                const fresh = getOrder(state, ev.orderId) || order;
                const failHint = () => buildDeliveryFailHint(reason);
                if (reason === 'captcha' || reason === 'banned') {
                    if (!fresh.botStatusHintAt) {
                        await sendChatMessage(client, chatId, failHint());
                        setOrderPhase(state, ev.orderId, fresh.phase, {
                            botStatusHintAt: new Date().toISOString(),
                            deliveryHintSentAt: new Date().toISOString(),
                        });
                    }
                } else {
                    await sendDeliveryHintOnce(
                        client,
                        state,
                        chatId,
                        ev.orderId,
                        fresh,
                        failHint,
                    );
                }
                console.warn(`[sell] fail ${ev.orderId}: ${reason}`);
            } else if (ev.type === 'invalid_nick') {
                if (!shouldProcessBotRetryEvent(order)) {
                    console.log(
                        `[sell] invalid_nick ${ev.orderId.slice(0, 8)}… игнор (заказ уже закрыт)`,
                    );
                    continue;
                }
                const session = getBuyerSession(state, chatId, buyerId);
                delete session.nick;
                markDeliveryPaused(state, ev.orderId, 'awaiting_nick', {
                    lastError: 'invalid_nick',
                    nick: null,
                });
                void dispatchCancelOrder(ev.orderId);
                await sendDeliveryHintOnce(
                    client,
                    state,
                    chatId,
                    ev.orderId,
                    getOrder(state, ev.orderId) || order,
                    buildWrongNickHint,
                );
            } else if (ev.type === 'player_offline') {
                if (!shouldProcessBotRetryEvent(order)) {
                    console.log(
                        `[sell] offline ${ev.orderId.slice(0, 8)}… игнор (заказ уже закрыт)`,
                    );
                    continue;
                }
                markDeliveryPaused(
                    state,
                    ev.orderId,
                    'awaiting_nick',
                    clanDeliveryRetryReset({
                        lastError: 'player_offline',
                        nick: getBuyerSession(state, chatId, buyerId).nick || order.nick,
                    }),
                );
                void dispatchCancelOrder(ev.orderId);
                await sendDeliveryHintOnce(
                    client,
                    state,
                    chatId,
                    ev.orderId,
                    getOrder(state, ev.orderId) || order,
                    () => buildDeliveryFailHint('player_offline'),
                );
            } else if (ev.type === 'insufficient_funds') {
                if (!shouldProcessBotRetryEvent(order)) {
                    console.log(
                        `[sell] insufficient_funds ${ev.orderId.slice(0, 8)}… игнор (заказ уже закрыт)`,
                    );
                    continue;
                }
                markDeliveryPaused(
                    state,
                    ev.orderId,
                    'awaiting_nick',
                    clanDeliveryRetryReset({
                        lastError: 'insufficient_funds',
                        nick: getBuyerSession(state, chatId, buyerId).nick || order.nick,
                    }),
                );
                void dispatchCancelOrder(ev.orderId);
                await sendDeliveryHintOnce(
                    client,
                    state,
                    chatId,
                    ev.orderId,
                    getOrder(state, ev.orderId) || order,
                    () => buildDeliveryFailHint('insufficient_funds'),
                );
                console.warn(
                    `[sell] insufficient_funds ${ev.orderId} — пополни баланс бота`,
                );
            }
        } catch (e) {
            console.warn(`[sell] ответ в чат: ${e.message}`);
        }
    }
}

/**
 * Ответ «заказ уже выполнен» — только на явный /nick после закрытия старой сделки.
 * «ник Steve» и /nick для новой оплаты — в syncChatNick / applyNickIntakes (и /nick от продавца).
 */
async function handleCompletedLateNick(client, state, chatId, messages, dealTimeline, sellerUserId) {
    for (const order of Object.values(state.orders)) {
        if (order.chatId !== chatId || order.phase !== 'completed') continue;
        if (buyerHasPendingOrder(state, chatId, order.buyerId)) continue;

        const completionAt =
            order.playerokMarkedAt || order.gameDeliveryAt || order.buyerNotifiedAt || null;
        if (!completionAt) continue;

        const oid = order.orderId || order.dealId;
        const session = getBuyerSession(state, chatId, order.buyerId);
        if (
            session.nickResetAt
            && completionAt
            && Date.parse(session.nickResetAt) > Date.parse(completionAt)
        ) {
            continue;
        }
        const hasNewerDeal = [...dealTimeline.values()].some(
            (snap) =>
                snap.buyerId === order.buyerId
                && snap.dealId !== oid
                && snap.at
                && Date.parse(snap.at) > Date.parse(completionAt),
        );
        if (hasNewerDeal) continue;

        const known = new Set(order.seenLateNickMessageIds || []);
        const updates = parseBuyerNickUpdates(
            messages,
            order.buyerId,
            completionAt,
            known,
            sellerUserId,
        );

        for (const u of updates) {
            known.add(u.messageId);
            if (order.lateNickHandled) continue;
            try {
                await sendChatMessage(client, chatId, buildOrderAlreadyDoneHint());
                console.log(
                    `[sell] ${oid.slice(0, 8)}…: /nick после выполнения (${u.nick})`,
                );
            } catch (e) {
                console.warn(`[sell] ${e.message}`);
            }
            setOrderPhase(state, oid, 'completed', {
                seenLateNickMessageIds: [...known],
                lateNickHandled: true,
            });
            break;
        }

        if (updates.length) {
            setOrderPhase(state, oid, 'completed', {
                seenLateNickMessageIds: [...known],
            });
        }
    }
}

function warnInvalidNickOnce(client, state, chatId, messages, deals, greetingAt) {
    const chat = ensureChat(state, chatId);

    for (const paid of deals) {
        const order = getOrder(state, paid.dealId);
        if (!order || order.phase === 'completed' || order.phase === 'dispatched' || order.phase === 'cancelled') {
            continue;
        }
        const buyerSession = getBuyerSession(state, chatId, paid.buyerId);
        if (buyerSession.nick) continue;
        if (buyerSession.wrongNickWarned) continue;

        const invalidNickOpts = { allowNikPhrase: true };

        for (const msg of messages) {
            if (!isBuyerUser(msg, paid.buyerId, paid.buyer || order.buyer) || !msg.text) continue;
            if (greetingAt && Date.parse(msg.createdAt) < Date.parse(greetingAt)) continue;
            if (!looksLikeInvalidNickAttempt(msg.text, invalidNickOpts)) continue;

            buyerSession.wrongNickWarned = true;
            void sendChatMessage(client, chatId, buildWrongNickHint()).catch((e) => {
                console.warn(`[sell] подсказка ник: ${e.message}`);
            });
            break;
        }
    }
}

async function processChat(client, state, chatId, sellerUserId, cutoffIso) {
    let msgData;
    try {
        msgData = await client.chatMessages(chatId);
    } catch (e) {
        console.warn(`[sell] chat ${chatId}: ${e.message}`);
        return;
    }

    let messages = flattenMessages(msgData);
    if (chatHasStuckOrders(state, chatId)) {
        try {
            messages = await fetchChatMessagesDeep(client, chatId);
            console.log(
                `[sell] чат ${chatId.slice(0, 8)}…: глубокая история, ${messages.length} сообщ.`,
            );
        } catch (e) {
            console.warn(`[sell] глубокая история чата: ${e.message}`);
        }
    }
    reconcileOrdersFromChatHistory(state, chatId, messages);
    const dealTimeline = buildDealStatusTimeline(messages);
    syncChatOrdersFromPlayerok(state, chatId, dealTimeline);

    const chatForBan = ensureChat(state, chatId);
    chatForBan.processedBanMessageIds = await applySellerBanCommands(
        client,
        state,
        chatId,
        messages,
        sellerUserId,
        new Set(chatForBan.processedBanMessageIds || []),
    );

    const dealsFromMessages = findAllCurrencyPaidDeals(messages);

    if (!dealsFromMessages.length && !chatHasOpenOrders(state, chatId) && !chatHasPendingOrders(state, chatId)) {
        for (const skip of findIgnoredPaidDeals(messages)) {
            const key = `skip:${skip.dealId}`;
            if (!state._loggedSkips) state._loggedSkips = {};
            if (!state._loggedSkips[key]) {
                state._loggedSkips[key] = true;
                console.log(`[sell] пропуск (не валюта kk): ${skip.itemName}`);
            }
        }
        await handleCompletedLateNick(client, state, chatId, messages, dealTimeline, sellerUserId);
        return;
    }

    const deals = mergeChatDeals(state, chatId, dealsFromMessages, dealTimeline);

    for (const paid of deals) {
        if (!paid.chatId) paid.chatId = chatId;
    }

    const newlyRegistered = registerDealOrders(
        state,
        dealsFromMessages,
        cutoffIso,
        dealTimeline,
    );
    syncChatOrdersFromPlayerok(state, chatId, dealTimeline);
    await rejectBannedBuyerOrdersInChat(client, state, chatId);

    if (republishWhen() === 'paid') {
        for (const order of newlyRegistered) {
            if (isBuyerBanned(state, order.buyerId)) continue;
            scheduleRepublishItem(client, state, order);
        }
    }
    const openDeals = filterActionableDeals(state, deals).filter(
        (d) => !isBuyerBanned(state, d.buyerId),
    );
    const pendingBuyerIds = [
        ...new Set(
            ordersInChat(state, chatId)
                .filter((o) => o.buyerId && !isOrderFulfilled(o) && !isBuyerBanned(state, o.buyerId))
                .map((o) => o.buyerId),
        ),
    ];
    if (!openDeals.length && !pendingBuyerIds.length) {
        await handleCompletedLateNick(client, state, chatId, messages, dealTimeline, sellerUserId);
        return;
    }

    const chatBeforeGreeting = ensureChat(state, chatId);
    const hadGreetingBefore =
        chatBeforeGreeting.greetingSent || hasGreetingInChat(messages, sellerUserId);

    let greetingAt = chatBeforeGreeting.greetingAt || null;
    if (openDeals.length) {
        greetingAt = await ensureChatGreeting(
            client,
            state,
            chatId,
            messages,
            sellerUserId,
            openDeals,
        );
    } else if (!greetingAt) {
        greetingAt = findGreetingAnchorInChat(messages, sellerUserId);
    }

    if (newlyRegistered.length) {
        await sendPremiumRefundUpsellForOrders(client, state, chatId, newlyRegistered);
    }

    if (hadGreetingBefore && newlyRegistered.length) {
        await sendTwinRemindersForNewOrders(client, state, chatId, newlyRegistered);
    }

    const buyerIds = [...new Set([...openDeals.map((d) => d.buyerId), ...pendingBuyerIds])];
    const chatKnown = ensureChat(state, chatId);
    if (!chatKnown.processedNickByBuyer) {
        chatKnown.processedNickByBuyer = {};
    }
    if (!chatKnown.processedSellerNickByBuyer) {
        chatKnown.processedSellerNickByBuyer = {};
    }
    const sellerUsername = state.sellerUsername ?? null;
    let cancelIds = new Set(chatKnown.processedCancelMessageIds || []);

    for (const buyerId of buyerIds) {
        let knownIds = new Set(chatKnown.processedNickByBuyer[buyerId] || []);
        const sellerKnownIds = new Set(chatKnown.processedSellerNickByBuyer[buyerId] || []);
        cancelIds = await applyCancelCommands(
            client,
            state,
            chatId,
            messages,
            buyerId,
            greetingAt,
            cancelIds,
        );
        syncChatNick(
            state,
            chatId,
            messages,
            buyerId,
            greetingAt,
            sellerUserId,
            sellerUsername,
        );
        const nickHandled = await applyNickCommandUpdates(
            state,
            chatId,
            messages,
            buyerId,
            greetingAt,
            knownIds,
            client,
            sellerUserId,
            sellerUsername,
            sellerKnownIds,
        );
        chatKnown.processedNickByBuyer[buyerId] = [...nickHandled.known];
        chatKnown.processedSellerNickByBuyer[buyerId] = [...nickHandled.sellerKnown];
    }
    chatKnown.processedCancelMessageIds = [...cancelIds];
    chatKnown.processedBanMessageIds = chatForBan.processedBanMessageIds;

    warnInvalidNickOnce(client, state, chatId, messages, openDeals, greetingAt);

    await flushChatDispatchQueue(state, openDeals, client);

    await handleCompletedLateNick(client, state, chatId, messages, dealTimeline, sellerUserId);
}

async function tick() {
    const client = createClient();
    const state = await loadState();
    ensurePollStarted(state);
    const cutoffIso = getDealCutoffIso(state);
    migrateStaleOrders(state, cutoffIso);
    cancelClosedOrdersOnSellbot(state);

    await handleBotEvents(client, state);
    await flushScheduledChatMessages(client, state);
    await retryWsPendingOrders(state);

    const viewerData = await client.viewer();
    const sellerUserId = viewerData.viewer.id;
    state.sellerUserId = sellerUserId;
    state.sellerUsername = viewerData.viewer.username;
    console.log(`[sell] ${viewerData.viewer.username} | чаты…`);

    const chatsData = await client.userChats(sellerUserId);
    const chats = flattenChats(chatsData);
    if (!chats.length) {
        console.log('[sell] чатов нет');
        await saveState(state);
        return;
    }

    for (const chat of chats) {
        if (!chat.id) continue;
        await processChat(client, state, chat.id, sellerUserId, cutoffIso);
    }

    await handleBotEvents(client, state);
    await flushScheduledChatMessages(client, state);
    await saveState(state);
}

async function main() {
    await assertPlayerokAuth();
    console.log(`[sell] автопродажа | анархия ${DELIVERY_ANARCHY} | ws sellbot`);
    do {
        try {
            await tick();
        } catch (e) {
            console.error('[sell]', e.message);
        }
        if (once) break;
        await new Promise((r) => setTimeout(r, pollMs));
    } while (!once);
}

main();
