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
} from './parse.mjs';
import { loadState, saveState, getOrder, setOrderPhase } from './state.mjs';
import { recordBuyerDelivery } from './lib/pay-bonus.mjs';
import {
    scheduleRepeatPromoMessage,
    flushScheduledChatMessages,
} from './lib/scheduled-chat.mjs';
import { drainBotEvents, dispatchCancelOrder } from './dispatch.mjs';
import { cancelClosedOrdersOnSellbot } from './lib/sellbot-cancel.mjs';
import { isOrderFulfilled } from './lib/playerok-deal-sync.mjs';
import { sendChatMessage } from './chat.mjs';
import {
    buildWrongNickHint,
    buildRetryNickHint,
    buildQueueStallHint,
    buildDeliveryOkHint,
    buildOrderAlreadyDoneHint,
    DELIVERY_ANARCHY,
} from './messages.mjs';
import { confirmDealOnPlayerok } from './confirm.mjs';
import { scheduleRepublishItem, republishWhen } from './publish.mjs';
import {
    registerDealOrders,
    filterActionableDeals,
    mergeChatDeals,
    chatHasOpenOrders,
    ensureChatGreeting,
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
    buildDealStatusTimeline,
    syncChatOrdersFromPlayerok,
    buyerHasPendingOrder,
} from './lib/playerok-deal-sync.mjs';
import {
    chatHasStuckOrders,
    fetchChatMessagesDeep,
    reconcileOrdersFromChatHistory,
} from './lib/chat-reconcile.mjs';
import { ensureChat, getBuyerSession } from './state.mjs';
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

async function handleBotEvents(client, state) {
    for (const ev of await drainBotEvents()) {
        const order = getOrder(state, ev.orderId);
        if (!order) {
            console.warn(`[sell] ws: неизвестный заказ ${ev.orderId}`);
            continue;
        }
        const chatId = order.chatId;
        const buyerId = order.buyerId;

        try {
            if (ev.type === 'delivery_ok') {
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
                setOrderPhase(state, ev.orderId, 'awaiting_nick', {
                    lastError: 'stall_queue',
                    nick,
                });
                await sendChatMessage(client, chatId, buildQueueStallHint());
                console.warn(`[sell] stall ${ev.orderId} (очередь ${ev.queued ?? '?'})`);
            } else if (ev.type === 'delivery_failed') {
                if (!shouldProcessBotRetryEvent(order)) {
                    console.log(
                        `[sell] fail ${ev.orderId.slice(0, 8)}… игнор (заказ уже закрыт): ${ev.reason || '?'}`,
                    );
                    continue;
                }
                const nick =
                    getBuyerSession(state, chatId, buyerId).nick || order.nick;
                setOrderPhase(state, ev.orderId, 'awaiting_nick', {
                    lastError: ev.reason || 'failed',
                    nick,
                });
                await sendChatMessage(client, chatId, buildRetryNickHint());
                console.warn(`[sell] fail ${ev.orderId}: ${ev.reason || '?'}`);
            } else if (ev.type === 'invalid_nick') {
                if (!shouldProcessBotRetryEvent(order)) {
                    console.log(
                        `[sell] invalid_nick ${ev.orderId.slice(0, 8)}… игнор (заказ уже закрыт)`,
                    );
                    continue;
                }
                const session = getBuyerSession(state, chatId, buyerId);
                delete session.nick;
                setOrderPhase(state, ev.orderId, 'awaiting_nick', {
                    lastError: 'invalid_nick',
                    nick: null,
                });
                await sendChatMessage(client, chatId, buildWrongNickHint());
            } else if (ev.type === 'player_offline') {
                if (!shouldProcessBotRetryEvent(order)) {
                    console.log(
                        `[sell] offline ${ev.orderId.slice(0, 8)}… игнор (заказ уже закрыт)`,
                    );
                    continue;
                }
                setOrderPhase(state, ev.orderId, 'awaiting_nick', {
                    lastError: 'player_offline',
                    nick: getBuyerSession(state, chatId, buyerId).nick || order.nick,
                });
                await sendChatMessage(client, chatId, buildRetryNickHint());
            }
        } catch (e) {
            console.warn(`[sell] ответ в чат: ${e.message}`);
        }
    }
}

/**
 * Ответ «заказ уже выполнен» — только на явный /nick после закрытия старой сделки.
 * «ник Steve» и /nick для новой оплаты — в syncChatNick / applyNickIntakes.
 */
async function handleCompletedLateNick(client, state, chatId, messages, dealTimeline) {
    for (const order of Object.values(state.orders)) {
        if (order.chatId !== chatId || order.phase !== 'completed') continue;
        if (buyerHasPendingOrder(state, chatId, order.buyerId)) continue;

        const completionAt =
            order.playerokMarkedAt || order.gameDeliveryAt || order.buyerNotifiedAt || null;
        if (!completionAt) continue;

        const oid = order.orderId || order.dealId;
        const hasNewerPaid = [...dealTimeline.values()].some(
            (snap) =>
                snap.buyerId === order.buyerId
                && snap.dealId !== oid
                && snap.status === 'PAID'
                && snap.at
                && Date.parse(snap.at) > Date.parse(completionAt),
        );
        if (hasNewerPaid) continue;

        const known = new Set(order.seenLateNickMessageIds || []);
        const updates = parseBuyerNickUpdates(messages, order.buyerId, completionAt, known);

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
            if (msg.user?.id !== paid.buyerId || !msg.text) continue;
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

    const dealsFromMessages = findAllCurrencyPaidDeals(messages);

    if (!dealsFromMessages.length && !chatHasOpenOrders(state, chatId)) {
        for (const skip of findIgnoredPaidDeals(messages)) {
            const key = `skip:${skip.dealId}`;
            if (!state._loggedSkips) state._loggedSkips = {};
            if (!state._loggedSkips[key]) {
                state._loggedSkips[key] = true;
                console.log(`[sell] пропуск (не валюта kk): ${skip.itemName}`);
            }
        }
        await handleCompletedLateNick(client, state, chatId, messages, dealTimeline);
        return;
    }

    const deals = mergeChatDeals(state, chatId, dealsFromMessages);

    for (const paid of deals) {
        if (!paid.chatId) paid.chatId = chatId;
    }

    const newlyRegistered = registerDealOrders(state, dealsFromMessages, cutoffIso);
    syncChatOrdersFromPlayerok(state, chatId, dealTimeline);

    if (republishWhen() === 'paid') {
        for (const order of newlyRegistered) {
            scheduleRepublishItem(client, state, order);
        }
    }
    const openDeals = filterActionableDeals(state, deals);
    if (!openDeals.length) {
        await handleCompletedLateNick(client, state, chatId, messages, dealTimeline);
        return;
    }

    const greetingAt = await ensureChatGreeting(
        client,
        state,
        chatId,
        messages,
        sellerUserId,
        openDeals,
    );

    const buyerIds = [...new Set(openDeals.map((d) => d.buyerId))];
    const chatKnown = ensureChat(state, chatId);
    let knownIds = new Set(chatKnown.processedNickMessageIds || []);
    let cancelIds = new Set(chatKnown.processedCancelMessageIds || []);

    for (const buyerId of buyerIds) {
        cancelIds = await applyCancelCommands(
            client,
            state,
            chatId,
            messages,
            buyerId,
            greetingAt,
            cancelIds,
        );
        syncChatNick(state, chatId, messages, buyerId, greetingAt);
        knownIds = await applyNickCommandUpdates(
            state,
            chatId,
            messages,
            buyerId,
            greetingAt,
            knownIds,
            client,
        );
    }
    chatKnown.processedNickMessageIds = [...knownIds];
    chatKnown.processedCancelMessageIds = [...cancelIds];

    warnInvalidNickOnce(client, state, chatId, messages, openDeals, greetingAt);

    await flushChatDispatchQueue(state, openDeals, client);

    await handleCompletedLateNick(client, state, chatId, messages, dealTimeline);
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
