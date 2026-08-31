import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRepublishOrder, skipRepublishReason } from './publish.mjs';

test('старые и отменённые 🎁 не перевыставляем', () => {
    const now = Date.parse('2026-09-01T00:00:00.000Z');
    assert.equal(
        skipRepublishReason(
            {
                amountKk: 55,
                itemName: '55КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС',
                paidAt: '2026-08-20T10:00:00.000Z',
            },
            now,
        ),
        'старше окна',
    );
    assert.equal(
        shouldRepublishOrder(
            {
                amountKk: 55,
                itemName: '55КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС',
                paidAt: '2026-08-31T20:00:00.000Z',
            },
            now,
        ),
        true,
    );
    assert.equal(
        skipRepublishReason({
            amountKk: 55,
            itemName: '55КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС',
            phase: 'cancelled',
            paidAt: '2026-08-31T20:00:00.000Z',
        }),
        'отменён',
    );
});

test('перевыставляем только 🎁, не премку', () => {
    assert.equal(
        shouldRepublishOrder({
            amountKk: 173,
            itemName: '173КК 🎁 МОМЕНТАЛЬНО 🎁 БОНУС',
        }),
        true,
    );
    assert.equal(
        shouldRepublishOrder({
            amountKk: 173,
            itemName: '173КК · МОМЕНТАЛЬНО · БОНУС',
        }),
        false,
    );
    assert.equal(
        skipRepublishReason({
            amountKk: 173,
            itemName: '173КК · МОМЕНТАЛЬНО · БОНУС',
        }),
        'платный лот, только 🎁',
    );
    assert.equal(shouldRepublishOrder({ itemName: 'без кк' }), false);
});
