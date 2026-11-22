import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRefundReminder, remindAfterUpsellRefund, REMINDER_MAX } from './refund-reminder.mjs';
import { buildPremiumRefundUpsellHint, buildUpsellRefundReminderHint } from '../messages.mjs';

const SELLER = 'seller-1';
const BUYER = 'buyer-1';
const min = (m) => new Date(Date.now() - m * 60_000).toISOString();

function st(over = {}) {
    return {
        orders: {
            o1: {
                orderId: 'o1',
                chatId: 'c1',
                buyerId: BUYER,
                buyer: '6TheBaze9',
                phase: 'cancelled',
                cancelReason: 'profile_upsell_refund',
                premiumRefundUpsellSentAt: min(10),
                profileUpsellUrl: 'https://playerok.com/products/x-75kk',
                profileUpsellKk: 75,
                profileUpsellBaseKk: 70,
                amountKk: 70,
                paidAt: min(11),
                ...over,
            },
        },
    };
}
const buyerMsg = (text, m) => ({ id: `b${m}`, text, createdAt: min(m), user: { id: BUYER, username: '6TheBaze9' } });
const sellerMsg = (text, m) => ({ id: `s${m}`, text, createdAt: min(m), user: { id: SELLER } });

test('после автовозврата пишет ник и /cancel → одно напоминание со ссылкой', async () => {
    const state = st();
    const msgs = [sellerMsg('↩️ возврат', 10), buyerMsg('wrot4ik_ggsss', 6), buyerMsg('/cancel', 4), buyerMsg('L4tik_gg22', 3)];
    const sent = [];
    const ok = await remindAfterUpsellRefund(state, 'c1', msgs, SELLER, async (c, t) => sent.push(t), (o) =>
        buildUpsellRefundReminderHint({ baseKk: o.profileUpsellBaseKk, upsellKk: o.profileUpsellKk, url: o.profileUpsellUrl }),
    );
    assert.equal(ok, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Заказ на 70кк отменён/);
    assert.match(sent[0], /75кк/);
    assert.match(sent[0], /x-75kk/);
    // те же сообщения на следующем проходе — повторно не отвечаем
    assert.equal(pickRefundReminder(state, 'c1', msgs, SELLER), null);
    // новое сообщение покупателя — отвечаем ещё раз
    assert.ok(pickRefundReminder(state, 'c1', [...msgs, { ...buyerMsg('??', 0), createdAt: new Date(Date.now() + 1000).toISOString() }], SELLER));
});

test('продавец уже ответил сам — молчим', () => {
    const msgs = [buyerMsg('wrot4ik_ggsss', 6), sellerMsg('тебе бот возврат сделал', 2)];
    assert.equal(pickRefundReminder(st(), 'c1', msgs, SELLER), null);
});

test('без сообщений покупателя после возврата — молчим', () => {
    assert.equal(pickRefundReminder(st(), 'c1', [buyerMsg('ник до возврата', 20)], SELLER), null);
});

test('купил новый лот после возврата — не мешаем', () => {
    const state = st();
    state.orders.o2 = { orderId: 'o2', chatId: 'c1', buyerId: BUYER, phase: 'completed', paidAt: min(5) };
    assert.equal(pickRefundReminder(state, 'c1', [buyerMsg('ник', 3)], SELLER), null);
});

test('лимит напоминаний и окно 24 ч', () => {
    assert.equal(pickRefundReminder(st({ refundReminderCount: REMINDER_MAX }), 'c1', [buyerMsg('x', 1)], SELLER), null);
    assert.equal(
        pickRefundReminder(st({ premiumRefundUpsellSentAt: min(25 * 60) }), 'c1', [buyerMsg('x', 1)], SELLER),
        null,
    );
});

test('обычная отмена (не автовозврат) — не наш случай', () => {
    assert.equal(pickRefundReminder(st({ cancelReason: 'buyer_cancel' }), 'c1', [buyerMsg('x', 1)], SELLER), null);
});

test('тексты', () => {
    const t = buildPremiumRefundUpsellHint({ upsellKk: 75, baseKk: 70, url: 'U' });
    assert.match(t, /Этот заказ отменён/);
    assert.match(t, /75кк вместо 70кк/);
    assert.match(t, /напиши ник/);
    assert.ok(t.endsWith('U'));
});
