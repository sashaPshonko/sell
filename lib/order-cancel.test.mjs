import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isBuyerOrderCancelBlocked,
    latestPaidDealIsSubscription,
} from './order-cancel.mjs';

function paid(at, name, buyerId = 'b1') {
    return {
        text: '{{ITEM_PAID}}',
        createdAt: at,
        deal: {
            direction: 'OUT',
            user: { id: buyerId },
            item: { name, slug: '', id: '' },
        },
    };
}

test('подписка с 🤖 блокирует /cancel', () => {
    const messages = [paid('2026-09-01T00:00:00.000Z', '🤖 7 дней')];
    const before = Date.parse('2026-09-01T00:01:00.000Z');
    assert.equal(latestPaidDealIsSubscription(messages, 'b1', before), true);
});

test('валюта kk не считается подпиской', () => {
    const messages = [paid('2026-09-01T00:00:00.000Z', '150kk FunTime ·')];
    const before = Date.parse('2026-09-01T00:01:00.000Z');
    assert.equal(latestPaidDealIsSubscription(messages, 'b1', before), false);
});

test('после подписки не отменяем старый kk — смотрим последнюю оплату', () => {
    const messages = [
        paid('2026-09-01T00:00:00.000Z', '150kk FunTime ·'),
        paid('2026-09-01T00:05:00.000Z', 'botpodpopcorn 7д'),
    ];
    const before = Date.parse('2026-09-01T00:06:00.000Z');
    assert.equal(latestPaidDealIsSubscription(messages, 'b1', before), true);
});

test('после kk снова можно /cancel', () => {
    const messages = [
        paid('2026-09-01T00:00:00.000Z', '🤖 7'),
        paid('2026-09-01T00:05:00.000Z', '150kk FunTime ·'),
    ];
    const before = Date.parse('2026-09-01T00:06:00.000Z');
    assert.equal(latestPaidDealIsSubscription(messages, 'b1', before), false);
});

test('заказ с казной по-прежнему blocked', () => {
    assert.equal(isBuyerOrderCancelBlocked({ clanInvestedAt: '2026-09-01T00:00:00.000Z' }), true);
    assert.equal(isBuyerOrderCancelBlocked({}), false);
});
