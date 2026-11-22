import test from 'node:test';
import assert from 'node:assert/strict';
import {
    healMergedOrders,
    isMergedGroupInDelivery,
    markMergedDelivered,
    mergeIntoPrimary,
    mergedTotalPay,
} from './order-merge.mjs';

function order(id, over = {}) {
    return {
        orderId: id,
        dealId: id,
        chatId: 'c1',
        buyerId: 'b1',
        buyer: 'mmstm',
        phase: 'awaiting_nick',
        playerokStatus: 'PAID',
        amountKk: 70,
        payAmountKk: 74,
        bonusComputedAt: 'x',
        paidAt: '2026-11-13T14:48:00Z',
        ...over,
    };
}
const mk = (...os) => ({ orders: Object.fromEntries(os.map((o) => [o.orderId, o])), botBalance: null });

/** a + b склеены, a отправлен в sellbot */
function merged(overA = {}, overB = {}) {
    const st = mk(order('a', overA), order('b', { amountKk: 300, payAmountKk: 310, paidAt: '2026-11-13T14:50:00Z', ...overB }));
    mergeIntoPrimary(st, st.orders.a, 'iriska');
    st.orders.a.phase = 'dispatched';
    return st;
}

test('два заказа одного покупателя → один перевод на сумму', () => {
    const st = mk(order('a'), order('b', { amountKk: 300, payAmountKk: 310, paidAt: '2026-11-13T14:50:00Z' }));
    const m = mergeIntoPrimary(st, st.orders.a, 'iriska');
    assert.deepEqual(m.ids, ['b']);
    assert.equal(m.total, 384);
    assert.equal(st.orders.b.mergedInto, 'a');
    assert.equal(st.orders.b.phase, 'dispatched');
    assert.equal(st.orders.b.nick, 'iriska');
    assert.deepEqual(st.orders.a.mergedOrderIds, ['b']);
    assert.equal(mergedTotalPay(st, st.orders.a), 384);
});

test('чужой покупатель, выданный, уже отправленный и закрытый на PlayerOK не склеиваются', () => {
    const st = mk(
        order('a'),
        order('x', { buyerId: 'b2' }),
        order('y', { phase: 'completed', gameDeliveryAt: 'z' }),
        order('z', { phase: 'dispatched' }),
        order('w', { playerokStatus: 'SENT' }),
        order('v', { pausedUntilNick: true, lastError: 'invalid_nick' }),
    );
    assert.equal(mergeIntoPrimary(st, st.orders.a, 'n'), null);
});

test('не хватает свежего баланса на сумму — не объединяем', () => {
    const st = mk(order('a', { payAmountKk: 200 }), order('b', { payAmountKk: 200 }));
    st.botBalance = { coins: 300_000_000, updatedAt: new Date().toISOString() };
    assert.equal(mergeIntoPrimary(st, st.orders.a, 'n'), null);
    assert.equal(st.orders.b.mergedInto, undefined);
    assert.equal(st.orders.a.mergedOrderIds, undefined);
});

test('delivery_ok основного: приклеенные закрыты сразу', () => {
    const st = merged();
    st.orders.a.phase = 'completed';
    st.orders.a.gameDeliveryAt = 'now';
    assert.deepEqual(markMergedDelivered(st, st.orders.a), ['b']);
    assert.equal(st.orders.b.phase, 'completed');
    assert.ok(st.orders.b.gameDeliveryAt);
    assert.deepEqual(healMergedOrders(st).finish, []); // повторно не трогаем
});

test('основной доставлен, а приклеенный не закрыт (сбой) → закрыть, не выдавать второй раз', () => {
    const st = merged();
    st.orders.a.phase = 'completed';
    st.orders.a.gameDeliveryAt = 'now';
    const { finish } = healMergedOrders(st);
    assert.deepEqual(finish, [{ sid: 'b', pid: 'a' }]);
    assert.equal(st.orders.b.phase, 'completed');
    assert.ok(st.orders.b.gameDeliveryAt);
});

test('основной на паузе (неверный ник) → группа ждёт; после нового ника сумма прежняя', () => {
    const st = merged();
    Object.assign(st.orders.a, { phase: 'awaiting_nick', pausedUntilNick: true, lastError: 'invalid_nick' });
    healMergedOrders(st);
    assert.equal(st.orders.b.mergedInto, 'a');
    assert.equal(st.orders.b.phase, 'dispatched');
    assert.equal(mergedTotalPay(st, st.orders.a), 384);
    assert.equal(isMergedGroupInDelivery(st, st.orders.b), false); // на паузе отменять можно
});

test('основному не хватило валюты → группа распущена, приклеенный на той же паузе без повторной подсказки', () => {
    const st = merged();
    Object.assign(st.orders.a, {
        phase: 'awaiting_nick',
        pausedUntilNick: true,
        lastError: 'insufficient_funds',
        deliveryHintSentAt: 'h',
    });
    healMergedOrders(st);
    const b = st.orders.b;
    assert.equal(b.mergedInto, undefined);
    assert.equal(b.phase, 'awaiting_nick');
    assert.equal(b.pausedUntilNick, true);
    assert.equal(b.lastError, 'insufficient_funds');
    assert.equal(b.deliveryHintSentAt, 'h');
    assert.ok(!st.orders.a.mergedOrderIds);
});

test('основной отменён → приклеенный выдаётся сам (без паузы)', () => {
    const st = merged();
    st.orders.a.phase = 'cancelled';
    healMergedOrders(st);
    assert.equal(st.orders.b.mergedInto, undefined);
    assert.equal(st.orders.b.phase, 'awaiting_nick');
    assert.ok(!st.orders.b.pausedUntilNick);
    assert.equal(st.orders.b.nick, 'iriska');
});

test('основной закрыт на PlayerOK без выдачи → приклеенный выдаётся сам', () => {
    const st = merged();
    Object.assign(st.orders.a, { phase: 'completed', playerokStatus: 'CONFIRMED' });
    healMergedOrders(st);
    assert.equal(st.orders.b.mergedInto, undefined);
    assert.equal(st.orders.b.phase, 'awaiting_nick');
});

test('основной закрыт по таймауту dispatch_stale → приклеенный закрыт так же', () => {
    const st = merged();
    Object.assign(st.orders.a, { phase: 'completed', stuckDispatchedAt: 't', lastError: 'dispatch_stale' });
    healMergedOrders(st);
    assert.equal(st.orders.b.phase, 'completed');
    assert.equal(st.orders.b.lastError, 'dispatch_stale');
});

test('основной вернулся в ожидание без паузы (ошибка отправки) → отвязываем, flush склеит заново', () => {
    const st = merged();
    st.orders.a.phase = 'awaiting_nick';
    healMergedOrders(st);
    assert.equal(st.orders.b.mergedInto, undefined);
    assert.ok(!st.orders.a.mergedOrderIds);
    const again = mergeIntoPrimary(st, st.orders.a, 'iriska');
    assert.equal(again.total, 384);
});

test('пока общий перевод в sellbot — отмена запрещена для обоих заказов группы', () => {
    const st = merged();
    assert.equal(isMergedGroupInDelivery(st, st.orders.a), true);
    assert.equal(isMergedGroupInDelivery(st, st.orders.b), true);
    st.orders.a.phase = 'ws_pending'; // в sellbot ещё нет
    assert.equal(isMergedGroupInDelivery(st, st.orders.b), false);
    const single = mk(order('s', { phase: 'dispatched' }));
    assert.equal(isMergedGroupInDelivery(single, single.orders.s), false);
});

test('приклеенный отменён до передачи в sellbot → сумма без него', () => {
    const st = merged();
    st.orders.a.phase = 'ws_pending';
    st.orders.b.phase = 'cancelled';
    assert.equal(mergedTotalPay(st, st.orders.a), 74);
    healMergedOrders(st);
    assert.equal(st.orders.b.mergedInto, undefined);
    assert.equal(st.orders.b.phase, 'cancelled');
    assert.deepEqual(markMergedDelivered(st, st.orders.a), []); // отменённый не «выдаём»
});

test('три заказа → один перевод, все закрываются', () => {
    const st = mk(order('a'), order('b'), order('c', { amountKk: 300, payAmountKk: 310 }));
    const m = mergeIntoPrimary(st, st.orders.a, 'n');
    assert.equal(m.total, 74 + 74 + 310);
    st.orders.a.phase = 'completed';
    st.orders.a.gameDeliveryAt = 'x';
    assert.deepEqual(markMergedDelivered(st, st.orders.a).sort(), ['b', 'c']);
});

test('dispatchOrder: приклеенный в sellbot отдельно не уходит', async () => {
    process.env.WS_DISABLE = '1';
    const { dispatchOrder } = await import('../dispatch.mjs');
    const st = merged();
    const r = await dispatchOrder({ ...st.orders.b }, st, { force: true });
    assert.deepEqual(r, { sent: 1, merged: true });
    st.orders.a.phase = 'cancelled'; // даже если основной сорвался — до разбора группы не шлём
    const r2 = await dispatchOrder({ ...st.orders.b }, st, { force: true });
    assert.deepEqual(r2, { sent: 1, merged: true });
    delete process.env.WS_DISABLE;
});

test('MERGE_ORDERS=0 отключает', () => {
    process.env.MERGE_ORDERS = '0';
    const st = mk(order('a'), order('b'));
    assert.equal(mergeIntoPrimary(st, st.orders.a, 'n'), null);
    delete process.env.MERGE_ORDERS;
});
