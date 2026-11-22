import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelMenuLabels, parseCancelChoice } from './cancel-menu.mjs';

test('выбор: эмодзи, цифра, «все»', () => {
    assert.equal(parseCancelChoice('1️⃣', 3), 1);
    assert.equal(parseCancelChoice('2⃣', 3), 2); // без вариационного селектора
    assert.equal(parseCancelChoice(' 3 ', 3), 3);
    assert.equal(parseCancelChoice('2.', 3), 2);
    assert.equal(parseCancelChoice('2)', 3), 2);
    assert.equal(parseCancelChoice('Все', 3), 3);
    assert.equal(parseCancelChoice('всё', 4), 4);
    assert.equal(parseCancelChoice('все заказы', 3), 3);
});

test('не выбор: ник, текст, номер вне меню', () => {
    assert.equal(parseCancelChoice('iriska228_', 3), null);
    assert.equal(parseCancelChoice('4', 3), null);
    assert.equal(parseCancelChoice('0', 3), null);
    assert.equal(parseCancelChoice('4️⃣', 3), null);
    assert.equal(parseCancelChoice('1 и 2', 3), null);
    assert.equal(parseCancelChoice('', 3), null);
    assert.equal(parseCancelChoice('/cancel', 3), null);
});

test('подписи: время только при одинаковых суммах', () => {
    assert.deepEqual(
        cancelMenuLabels([
            { amountKk: 70, paidAt: '2026-11-13T14:48:00Z' },
            { amountKk: 70, paidAt: '2026-11-13T15:02:00Z' },
            { amountKk: 300, paidAt: '2026-11-13T15:05:00Z' },
        ]),
        ['70кк (оплата в 17:48)', '70кк (оплата в 18:02)', '300кк'],
    );
});
