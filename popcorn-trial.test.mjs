import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPopcornTrialHint,
    popcornTrialUrl,
    DEFAULT_POPCORN_TRIAL_URL,
} from './messages.mjs';
import { isSubscriptionLot, parseSubscriptionDays } from './parse.mjs';
import {
    pickPostDeliveryUpsellKind,
    schedulePostDeliveryMessages,
} from './lib/scheduled-chat.mjs';

test('пробник 3 дня — ссылка и текст без олух', () => {
    const t = buildPopcornTrialHint();
    assert.match(t, /фармить как я/i);
    assert.match(t, /ботов/);
    assert.equal(/олух/i.test(t), false);
    assert.ok(t.includes(DEFAULT_POPCORN_TRIAL_URL));
});

test('лот 3 дня парсится как подписка на 3д', () => {
    const name = 'ФАРМ-БОТ 🤖 FUNTIME 🤖 3 ДНЯ';
    assert.equal(isSubscriptionLot(name), true);
    assert.equal(parseSubscriptionDays(name), 3);
});

test('POPCORN_TRIAL_URL=0 выключает апселл', () => {
    const prev = process.env.POPCORN_TRIAL_URL;
    process.env.POPCORN_TRIAL_URL = '0';
    try {
        assert.equal(popcornTrialUrl(), '');
        assert.equal(buildPopcornTrialHint(), '');
    } finally {
        if (prev == null) delete process.env.POPCORN_TRIAL_URL;
        else process.env.POPCORN_TRIAL_URL = prev;
    }
});

function orderState(orders) {
    const map = {};
    for (const o of orders) {
        const id = o.orderId || o.dealId;
        map[id] = { ...o, orderId: id, dealId: id };
    }
    return { orders: map, scheduledChatMessages: [] };
}

test('🎁-лот — всегда ссылка на ботов, не профиль', () => {
    const id = 'gift-1';
    const state = orderState([
        {
            orderId: id,
            buyerId: 'b1',
            itemName: '55КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС',
            amountKk: 55,
        },
    ]);
    assert.equal(pickPostDeliveryUpsellKind(state, state.orders[id]), 'popcorn');
});

test('премка без 🎁 — 50/50 по roll', () => {
    const id = 'prem-1';
    const state = orderState([
        {
            orderId: id,
            buyerId: 'b1',
            itemName: '50КК · МОМЕНТАЛЬНО · БОНУС',
            amountKk: 50,
        },
    ]);
    const order = state.orders[id];
    assert.equal(pickPostDeliveryUpsellKind(state, order, { roll: 0.1 }), 'popcorn');
    assert.equal(pickPostDeliveryUpsellKind(state, order, { roll: 0.9 }), 'profile');
});

test('покупал 🎁 раньше — премка тоже только боты', () => {
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
    assert.equal(
        pickPostDeliveryUpsellKind(state, state.orders['new-prem'], { roll: 0.99 }),
        'popcorn',
    );
});

test('schedule: 🎁 не ставит profile_upsell в очередь', () => {
    const id = 'g2';
    const state = orderState([
        {
            orderId: id,
            buyerId: 'b1',
            chatId: 'c1',
            itemName: '44КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС',
            amountKk: 44,
            phase: 'completed',
        },
    ]);
    schedulePostDeliveryMessages(state, 'c1', id);
    const kinds = (state.scheduledChatMessages || []).map((x) => x.kind);
    assert.deepEqual(kinds, ['popcorn_trial']);
    assert.equal(state.orders[id].postDeliveryUpsellKind, 'popcorn');
});
