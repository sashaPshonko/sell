import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBuyerOrderCancelBlocked, isSubscriptionCancelBlocked } from './order-cancel.mjs';

test('заказ с казной по-прежнему blocked', () => {
    assert.equal(isBuyerOrderCancelBlocked({ clanInvestedAt: '2026-09-01T00:00:00.000Z' }), true);
    assert.equal(isBuyerOrderCancelBlocked({}), false);
});

test('подписка blocked, валюта нет', () => {
    assert.equal(isSubscriptionCancelBlocked({ itemName: '🤖 7 дней' }), true);
    assert.equal(isSubscriptionCancelBlocked({ itemName: '55КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС' }), false);
});
