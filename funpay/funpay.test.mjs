import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAppPage, parseSales, parseOrderPage, parseChatMessages, FunPayClient } from './client.mjs';
import { computeOrderKk, parseUnitKk, parseMinKk } from './amount.mjs';
import { parseOwnLots } from './client.mjs';

test('parseAppPage: csrf, id, ник', () => {
    const html = `<html><body data-app-data='{"userId":123,"csrf-token":"abc","locale":"ru"}'><div class="user-link-name">seller</div></body></html>`;
    assert.deepEqual(parseAppPage(html), { userId: 123, csrf: 'abc', username: 'seller' });
});

test('parseAppPage: без ника — ошибка авторизации', () => {
    assert.throws(() => parseAppPage('<html><body data-app-data="{}"></body></html>'), (e) => e.kind === 'auth');
});

const SALES = `
<a href="https://funpay.com/orders/ABCD1234/" class="tc-item info">
  <div class="tc-date"><div class="tc-date-time">сегодня, 12:00</div></div>
  <div class="tc-order">#ABCD1234</div>
  <div class="order-desc"><div>Монеты FunTime 10кк, Анархия 221</div><div class="text-muted">FunTime, Монеты</div></div>
  <div class="tc-user"><div class="media-user-name"><span data-href="https://funpay.com/users/777/">buyer1</span></div></div>
  <div class="tc-status">Оплачен</div>
  <div class="tc-price">150 ₽</div>
</a>
<a href="https://funpay.com/orders/ZZZ/" class="tc-item warning">
  <div class="tc-order">#ZZZ</div>
  <div class="order-desc"><div>Монеты 1кк</div></div>
  <div class="media-user-name"><span data-href="https://funpay.com/users/5/">b2</span></div>
  <div class="tc-price">10 ₽</div>
</a>
<a class="tc-item"><div class="tc-order">#OLD</div><div class="order-desc"><div>x</div></div>
<div class="tc-price">1 ₽</div></a>
<input type="hidden" name="continue" value="NEXT1">`;

test('parseSales: статусы, id, покупатель, цена, continue', () => {
    const { orders, next } = parseSales(SALES);
    assert.equal(orders.length, 3);
    assert.deepEqual(orders.map((o) => [o.id, o.status]), [['ABCD1234', 'paid'], ['ZZZ', 'refunded'], ['OLD', 'closed']]);
    assert.equal(orders[0].buyerId, 777);
    assert.equal(orders[0].buyerName, 'buyer1');
    assert.equal(orders[0].price, 150);
    assert.equal(orders[0].currency, '₽');
    assert.match(orders[0].description, /10кк/);
    assert.equal(next, 'NEXT1');
});

test('parseOrderPage: количество и описание', () => {
    const html = `
    <div class="param-item"><h5>Краткое описание</h5><div>Монеты FunTime 10кк</div></div>
    <div class="param-item"><h5>Количество</h5><div>3 шт.</div></div>`;
    const d = parseOrderPage(html);
    assert.equal(d.quantity, 3);
    assert.equal(d.shortDescription, 'Монеты FunTime 10кк');
});

test('parseChatMessages: автор, текст, системные', () => {
    const msgs = parseChatMessages([
        { id: 1, author: 0, html: '<div role="alert">Покупатель оплатил заказ #ABCD1234</div>' },
        { id: 2, author: 777, html: '<div class="chat-msg-body"><div class="chat-msg-text">Steve_1</div></div>' },
    ]);
    assert.equal(msgs[0].system, true);
    assert.match(msgs[0].text, /#ABCD1234/);
    assert.equal(msgs[1].author, 777);
    assert.equal(msgs[1].text, 'Steve_1');
});

test('chatNode: id по возрастанию', () => {
    const c = new FunPayClient({ goldenKey: 'x' });
    c.userId = 900;
    assert.equal(c.chatNode(777), 'users-777-900');
    assert.equal(c.chatNode(1000), 'users-900-1000');
});

test('parseUnitKk', () => {
    assert.equal(parseUnitKk('Монеты 10кк'), 10);
    assert.equal(parseUnitKk('100 KK FunTime'), 100);
    assert.equal(parseUnitKk('2,5кк'), 2.5);
    assert.equal(parseUnitKk('Монеты FunTime'), null);
});

test('computeOrderKk: цена за 1кк — выдаём столько кк, сколько куплено; число в описании игнорируем', () => {
    assert.deepEqual(computeOrderKk({ shortDescription: 'Монеты 10кк', quantity: 300 }), { ok: true, amountKk: 300, unitKk: 1, quantity: 300 });
    assert.equal(computeOrderKk({ shortDescription: 'Монеты FunTime', quantity: 200 }).amountKk, 200);
    const nq = computeOrderKk({ shortDescription: 'x', quantity: null });
    assert.equal(nq.ok, false);
    assert.equal(nq.tooSmall, undefined, 'не прочитали количество — не возврат');
    assert.equal(computeOrderKk({ quantity: 5000 }).ok, true, 'потолка нет');
    assert.equal(computeOrderKk({ quantity: 1 }).tooSmall, true);
});

test('computeOrderKk: единица из описания, если включено', () => {
    assert.deepEqual(computeOrderKk({ shortDescription: 'Монеты 10кк', quantity: 3 }, { unitFromDesc: true, minKk: 1 }), { ok: true, amountKk: 30, unitKk: 10, quantity: 3 });
    assert.equal(computeOrderKk({ shortDescription: 'Монеты 10кк', quantity: 100 }, { unitFromDesc: true, maxKk: 500 }).ok, false);
});

test('минимальная выдача 200кк: меньше — tooSmall (возврат)', () => {
    const r = computeOrderKk({ quantity: 130 });
    assert.equal(r.ok, false);
    assert.equal(r.tooSmall, true);
    assert.equal(computeOrderKk({ quantity: 199 }).tooSmall, true);
    assert.equal(computeOrderKk({ quantity: 200 }).ok, true);
});

test('parseMinKk: минимальная выдача из описания', () => {
    assert.equal(parseMinKk('ВАЛЮТА БЕЗ БАНОВ - АВТОВЫДАЧА ОТ 200КК'), 200);
    assert.equal(parseMinKk('Минимум 150 кк'), 150);
    assert.equal(parseMinKk('мин. сумма 100кк'), 100);
    assert.equal(parseMinKk('минимальная выдача: 250kk'), 250);
    assert.equal(parseMinKk('ПОКУПАТЬ ТОЛЬКО 130-260-390'), null);
    assert.equal(parseMinKk('Валюта FunTime 1.21'), null);
});

test('parseOwnLots: описание лота', () => {
    const html = '<a class="tc-item" href="https://funpay.com/lots/offer?id=1"><div class="tc-desc-text">ВАЛЮТА - ОТ 200КК, FunTime</div></a><a class="tc-item" href="https://funpay.com/orders/X/"><div class="tc-desc-text">не лот</div></a>';
    assert.deepEqual(parseOwnLots(html), [{ href: 'https://funpay.com/lots/offer?id=1', description: 'ВАЛЮТА - ОТ 200КК, FunTime' }]);
});

test('computeOrderKk: свой минимум из описания', () => {
    assert.equal(computeOrderKk({ quantity: 150 }, { minKk: 100 }).ok, true);
    assert.equal(computeOrderKk({ quantity: 150 }, { minKk: 300 }).tooSmall, true);
});

const PROFILE = (reg) => `<div class="profile-header-cols"><div class="param-item"><h5 class="text-bold">Дата регистрации</h5><div class="text-nowrap">
 ${reg}<br> 4 года назад </div></div></div>`;

test('parseRegisteredAt: дата регистрации (МСК → UTC)', async () => {
    const { parseRegisteredAt } = await import('./client.mjs');
    assert.equal(parseRegisteredAt(PROFILE('4 июня 2022, 14:29')), Date.UTC(2022, 5, 4, 11, 29));
    assert.equal(parseRegisteredAt(PROFILE('30 октября 2018, 00:05')), Date.UTC(2018, 9, 29, 21, 5));
});

test('parseRegisteredAt: нет блока / незнакомый месяц → null', async () => {
    const { parseRegisteredAt } = await import('./client.mjs');
    assert.equal(parseRegisteredAt('<html></html>'), null);
    assert.equal(parseRegisteredAt(PROFILE('4 фруктября 2022, 14:29')), null);
});

test('текст возврата: 90 дней → «3 месяцев»', async () => {
    const T = await import('./texts.mjs');
    assert.match(T.refundedYoungAccount(90), /старше 3 месяцев/);
    assert.match(T.refundedYoungAccount(45), /старше 45 дней/);
});
