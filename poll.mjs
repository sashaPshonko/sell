import { loadEnv } from './lib/env.mjs';
import { createClient } from './playerok-client.mjs';
import {
    findAllCurrencyPaidDeals,
    findIgnoredPaidDeals,
    flattenChats,
    flattenMessages,
    findBuyerNickAttemptsAfter,
    looksLikeInvalidNickAttempt,
} from './parse.mjs';
import { loadState, saveState, getOrder, setOrderPhase } from './state.mjs';
import { drainBotEvents } from './dispatch.mjs';
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
import {
    registerDealOrders,
    filterActionableDeals,
    ensureChatGreeting,
    syncChatNick,
    applyNickCommandUpdates,
    applyCancelCommands,
    flushChatDispatchQueue,
} from './chat-session.mjs';
import {
    ensurePollStarted,
    getDealCutoffIso,
    migrateStaleOrders,
} from './lib/deal-cutoff.mjs';
import { ensureChat, getBuyerSession } from './state.mjs';

loadEnv();

const once = process.argv.includes('--once');
const pollMs = Number(process.env.POLL_MS || 15000);

async function markPlayerokDone(client, state, dealId) {
    if (process.env.AUTO_MARK_PLAYEROK === '0') return;
    try {
        await confirmDealOnPlayerok(client, dealId);
        setOrderPhase(state, dealId, 'completed', {
            playerokMarkedAt: new Date().toISOString(),
            playerokStatus: process.env.CONFIRM_DEAL_STATUS || 'SENT',
        });
        console.log(`[sell] PlayerOK SENT: ${dealId}`);
    } catch (e) {
        console.warn(`[sell] PlayerOK: ${e.message}`);
    }
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
                await sendChatMessage(
                    client,
                    chatId,
                    buildDeliveryOkHint(order.amountKk),
                );
                await markPlayerokDone(client, state, ev.orderId);
                console.log(`[sell] выдано: ${ev.orderId} (${order.amountKk}kk)`);
            } else if (ev.type === 'delivery_stalled') {
                const nick =
                    getBuyerSession(state, chatId, buyerId).nick || order.nick;
                setOrderPhase(state, ev.orderId, 'awaiting_nick', {
                    lastError: 'stall_queue',
                    nick,
                });
                await sendChatMessage(client, chatId, buildQueueStallHint());
                console.warn(`[sell] stall ${ev.orderId} (очередь ${ev.queued ?? '?'})`);
            } else if (ev.type === 'delivery_failed') {
                const nick =
                    getBuyerSession(state, chatId, buyerId).nick || order.nick;
                setOrderPhase(state, ev.orderId, 'awaiting_nick', {
                    lastError: ev.reason || 'failed',
                    nick,
                });
                await sendChatMessage(client, chatId, buildRetryNickHint());
                console.warn(`[sell] fail ${ev.orderId}: ${ev.reason || '?'}`);
            } else if (ev.type === 'invalid_nick') {
                const session = getBuyerSession(state, chatId, buyerId);
                delete session.nick;
                setOrderPhase(state, ev.orderId, 'awaiting_nick', {
                    lastError: 'invalid_nick',
                    nick: null,
                });
                await sendChatMessage(client, chatId, buildWrongNickHint());
            } else if (ev.type === 'player_offline') {
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

async function handleCompletedLateNick(client, state, chatId, messages, sellerUserId) {
    const chat = ensureChat(state, chatId);
    const greetingAt = chat.greetingAt;

    for (const order of Object.values(state.orders)) {
        if (order.chatId !== chatId || order.phase !== 'completed') continue;

        const after =
            order.playerokMarkedAt ||
            order.dispatchedAt ||
            order.greetedAt ||
            greetingAt ||
            new Date(0).toISOString();
        const known = new Set(order.seenMessageIds || []);
        const attempts = findBuyerNickAttemptsAfter(
            messages,
            order.buyerId,
            after,
            known,
        );

        for (const a of attempts) {
            known.add(a.messageId);
            if (order.lateNickHandled) continue;
            try {
                await sendChatMessage(client, chatId, buildOrderAlreadyDoneHint());
                console.log(`[sell] ${order.orderId.slice(0, 8)}…: /nick после выполнения`);
            } catch (e) {
                console.warn(`[sell] ${e.message}`);
            }
            setOrderPhase(state, order.orderId, 'completed', {
                seenMessageIds: [...known],
                lateNickHandled: true,
            });
            break;
        }

        if (attempts.length) {
            setOrderPhase(state, order.orderId, 'completed', {
                seenMessageIds: [...known],
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
        if (getBuyerSession(state, chatId, paid.buyerId).nick) continue;

        const buyerSession = getBuyerSession(state, chatId, paid.buyerId);
        if (buyerSession.wrongNickWarned) continue;

        for (const msg of messages) {
            if (msg.user?.id !== paid.buyerId || !msg.text) continue;
            if (greetingAt && Date.parse(msg.createdAt) < Date.parse(greetingAt)) continue;
            if (!looksLikeInvalidNickAttempt(msg.text)) continue;

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

    const messages = flattenMessages(msgData);
    const deals = findAllCurrencyPaidDeals(messages);

    if (!deals.length) {
        for (const skip of findIgnoredPaidDeals(messages)) {
            const key = `skip:${skip.dealId}`;
            if (!state._loggedSkips) state._loggedSkips = {};
            if (!state._loggedSkips[key]) {
                state._loggedSkips[key] = true;
                console.log(`[sell] пропуск (не валюта kk): ${skip.itemName}`);
            }
        }
        return;
    }

    for (const paid of deals) {
        if (!paid.chatId) paid.chatId = chatId;
    }

    registerDealOrders(state, deals, cutoffIso);
    const openDeals = filterActionableDeals(state, deals);
    if (!openDeals.length) return;

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
        );
    }
    chatKnown.processedNickMessageIds = [...knownIds];
    chatKnown.processedCancelMessageIds = [...cancelIds];

    warnInvalidNickOnce(client, state, chatId, messages, openDeals, greetingAt);

    await flushChatDispatchQueue(state, openDeals);

    await handleCompletedLateNick(client, state, chatId, messages, sellerUserId);
}

async function tick() {
    const client = createClient();
    const state = await loadState();
    ensurePollStarted(state);
    const cutoffIso = getDealCutoffIso(state);
    migrateStaleOrders(state, cutoffIso);

    await handleBotEvents(client, state);

    const viewerData = await client.viewer();
    const sellerUserId = viewerData.viewer.id;
    const userId = process.env.PLAYEROK_USER_ID || sellerUserId;
    console.log(`[sell] ${viewerData.viewer.username} | чаты…`);

    const chatsData = await client.userChats(userId);
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
    await saveState(state);
}

async function main() {
    console.log(`[sell] автопродажа | анархия ${DELIVERY_ANARCHY()} | ws sellbot`);
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
