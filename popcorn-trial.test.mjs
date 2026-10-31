import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPopcornTrialHint, popcornTrialUrl } from './messages.mjs';
import { isSubscriptionLot, parseSubscriptionDays } from './parse.mjs';
import {
    pickPostDeliveryUpsellKind,
    schedulePostDeliveryMessages,
} from './lib/scheduled-chat.mjs';

test('пробник ботов в чат не шлём', () => {
    assert.equal(popcornTrialUrl(), '');
    assert.equal(buildPopcornTrialHint(), '');
});

test('лот 3 дня парсится как подписка на 3д', () => {
    const name = 'ФАРМ-БОТ 🤖 FUNTIME 🤖 3 ДНЯ';
    assert.equal(isSubscriptionLot(name), true);
    assert.equal(parseSubscriptionDays(name), 3);
});

function orderState(orders) {
    const map = {};
    for (const o of orders) {
        const id = o.orderId || o.dealId;
        map[id] = { ...o, orderId: id, dealId: id };
    }
    return { orders: map, scheduledChatMessages: [] };
}

test('🎁-лот — без рассылки', () => {
    const id = 'gift-1';
    const state = orderState([
        {
            orderId: id,
            buyerId: 'b1',
            itemName: '55КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС',
            amountKk: 55,
        },
    ]);
    assert.equal(pickPostDeliveryUpsellKind(state, state.orders[id]), null);
});

test('премка — только лот без премки', () => {
    const id = 'prem-1';
    const state = orderState([
        {
            orderId: id,
            buyerId: 'b1',
            itemName: '50КК · МОМЕНТАЛЬНО · БОНУС',
            amountKk: 50,
        },
    ]);
    assert.equal(pickPostDeliveryUpsellKind(state, state.orders[id]), 'profile');
});

test('покупал 🎁 раньше — премка без рассылки', () => {
    const state = orderState([
        {
            orderId: 'old-gift',
            buyerId: 'b1',
            itemName: '55КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС',
            amountKk: 55,
            phase: 'completed',
        },
        {
            orderId: 'new-prem',
            buyerId: 'b1',
            itemName: '50КК · МОМЕНТАЛЬНО · БОНУС',
            amountKk: 50,
        },
    ]);
    assert.equal(pickPostDeliveryUpsellKind(state, state.orders['new-prem']), null);
});

test('schedule: 🎁 не ставит очередь, премка ставит profile_upsell', () => {
    const giftId = 'g2';
    const premId = 'p2';
    const state = orderState([
        {
            orderId: giftId,
            buyerId: 'b1',
            chatId: 'c1',
            itemName: '44КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС',
            amountKk: 44,
            phase: 'completed',
        },
        {
            orderId: premId,
            buyerId: 'b2',
            chatId: 'c2',
            itemName: '50КК · МОМЕНТАЛЬНО · БОНУС',
            amountKk: 50,
            phase: 'completed',
        },
    ]);
    schedulePostDeliveryMessages(state, 'c1', giftId);
    schedulePostDeliveryMessages(state, 'c2', premId);
    const kinds = (state.scheduledChatMessages || []).map((x) => x.kind);
    assert.deepEqual(kinds, ['profile_upsell']);
    assert.equal(state.orders[giftId].postDeliveryUpsellKind, undefined);
    assert.equal(state.orders[premId].postDeliveryUpsellKind, 'profile');
});
