import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isBotFatalPaused,
    isBotFatalDeliveryError,
    canDispatchToSellbot,
    recoverBotFatalPausedOrders,
} from './playerok-deal-sync.mjs';

test('bot fatal pause блокирует dispatch', () => {
    const order = {
        phase: 'awaiting_nick',
        lastError: 'banned',
        botStatusHintAt: '2026-01-01T00:00:00.000Z',
        pausedUntilNick: true,
        nick: 'ws222sw',
    };
    assert.equal(isBotFatalDeliveryError('banned'), true);
    assert.equal(isBotFatalPaused(order), true);
    assert.equal(canDispatchToSellbot(order), false);
});

test('recoverBotFatalPausedOrders снимает паузу после bot_balance', () => {
    const state = {
        orders: {
            a: {
                orderId: 'a',
                phase: 'awaiting_nick',
                lastError: 'banned',
                botStatusHintAt: '2026-01-01T00:00:00.000Z',
                pausedUntilNick: true,
            },
        },
    };
    assert.equal(recoverBotFatalPausedOrders(state, { username: 'newbot' }), 1);
    assert.equal(isBotFatalPaused(state.orders.a), false);
    assert.equal(state.orders.a.pausedUntilNick, true);
});
