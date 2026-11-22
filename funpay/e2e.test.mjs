import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

/** Сквозная проверка poll.mjs: поддельный FunPay (HTTP) + поддельный оркестратор (WS). */
const ME = 900;
const BUYER = 777;

function appPage() {
    return `<html><body data-app-data='{"userId":${ME},"csrf-token":"tok"}'><div class="user-link-name">seller</div></body></html>`;
}
const row = (id, cls, desc) => `<a class="tc-item ${cls}"><div class="tc-order">#${id}</div><div class="order-desc"><div>${desc}</div></div>
<div class="media-user-name"><span data-href="https://funpay.com/users/${BUYER}/">buyer</span></div><div class="tc-price">100 ₽</div></a>`;

test('оплата → ник → заказ в оркестратор → delivery_ok → «выдано» в чат', async (t) => {
    const sent = []; // сообщения продавца в чат
    const chat = [{ id: 1, author: 0, html: '<div role="alert">Покупатель оплатил заказ #OLD1</div>' }];
    let sales = row('OLD1', 'info', 'Монеты 10кк');
    let nextId = 2;

    const srv = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') return res.end(appPage());
        if (url.pathname === '/orders/trade') return res.end(`<html><body>${sales}</body></html>`);
        if (url.pathname.startsWith('/orders/NEW1')) {
            return res.end('<div class="param-item"><h5>Краткое описание</h5><div>Монеты 10кк</div></div><div class="param-item"><h5>Количество</h5><div>200 шт.</div></div>');
        }
        if (url.pathname === '/runner/') {
            let b = '';
            req.on('data', (d) => (b += d));
            req.on('end', () => {
                const p = new URLSearchParams(b);
                const objs = JSON.parse(p.get('objects'));
                const reqv = p.get('request');
                if (reqv && reqv !== 'false') {
                    const r = JSON.parse(reqv);
                    sent.push(r.data.content);
                    chat.push({ id: nextId++, author: ME, html: `<div class="chat-msg-text">${r.data.content}</div>` });
                }
                const out = objs.map((o) => {
                    const last = Number(o.data.last_message);
                    return { type: 'chat_node', id: o.id, tag: 'x', data: { node: { id: 1, name: o.id }, messages: chat.filter((m) => last < 0 || m.id > last) } };
                });
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ objects: out, response: {} }));
            });
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise((r) => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    const orders = [];
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.on('listening', r));
    wss.on('connection', (sock) =>
        sock.on('message', (raw) => {
            const m = JSON.parse(String(raw));
            if (m.type === 'order') {
                orders.push(m);
                sock.send(JSON.stringify({ type: 'bot_event', event: { type: 'delivery_ok', orderId: m.orderId, nick: m.nick } }));
            }
        }),
    );

    const dir = mkdtempSync(join(tmpdir(), 'fp-e2e-'));
    const child = spawn('node', ['funpay/poll.mjs'], {
        env: {
            ...process.env,
            FUNPAY_BASE: base,
            FUNPAY_GOLDEN_KEY: 'test',
            FUNPAY_LIVE: '1',
            FUNPAY_POLL_MS: '200',
            FUNPAY_CHAT_MS: '200',
            FUNPAY_STATE_FILE: join(dir, 'state.json'),
            FUNPAY_POLL_LOCK: join(dir, 'lock.pid'),
            WS_URL: `ws://127.0.0.1:${wss.address().port}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    t.after(() => {
        child.kill();
        srv.close();
        wss.close();
    });
    const until = async (cond, what) => {
        for (let i = 0; i < 100; i++) {
            if (cond()) return;
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`не дождались: ${what}\n${out}`);
    };

    await until(() => existsSync(join(dir, 'state.json')), 'первый запуск');
    assert.equal(sent.length, 0, 'старую оплату OLD1 не трогаем');

    // новая оплата
    chat.push({ id: nextId++, author: 0, html: '<div role="alert">Покупатель оплатил заказ #NEW1</div>' });
    sales = row('NEW1', 'info', 'Монеты 10кк') + sales;
    await until(() => sent.some((s) => s.includes('NEW1') && s.includes('200кк')), 'приветствие');
    assert.equal(orders.length, 0, 'без ника заказ боту не уходит');

    // покупатель присылает ник
    chat.push({ id: nextId++, author: BUYER, html: '<div class="chat-msg-text">Steve_1</div>' });
    await until(() => orders.length === 1, 'заказ в оркестратор');
    assert.equal(orders[0].orderId, 'fp-NEW1');
    assert.equal(orders[0].nick, 'Steve_1');
    assert.equal(orders[0].amount, 200);
    await until(() => sent.some((s) => s.includes('Валюта выдана')), 'сообщение о выдаче');
    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(st.orders.NEW1.phase, 'delivered');
    assert.equal(st.orders.OLD1.phase, 'skipped');
    assert.equal(orders.length, 1, 'дубля заказа нет');
});
