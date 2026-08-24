import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRepublishOrder, skipRepublishReason } from './publish.mjs';

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
