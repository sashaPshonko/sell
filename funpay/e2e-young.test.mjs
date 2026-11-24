import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ME = 900;
const BUYER = 777;
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const regText = (daysAgo) => { const d = new Date(Date.now() - daysAgo * 86400000 + 3 * 3600000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`; };
const row = (id, cls, desc) => `<a class="tc-item ${cls}"><div class="tc-order">#${id}</div><div class="order-desc"><div>${desc}</div></div>
<div class="media-user-name"><span data-href="https://funpay.com/users/${BUYER}/">buyer</span></div><div class="tc-price">100 ₽</div></a>`;

test('покупатель с аккаунтом младше 90 дней → возврат + вежливое сообщение, боту не уходит', async (t) => {
    const sent = [];
    const refunds = [];
    let sales = row('OLD1', 'info', 'Монеты');
    const chat = [{ id: 1, author: 0, html: '<div role="alert">Покупатель оплатил заказ #YNG1</div>' }];
    const srv = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') return res.end(`<html><body data-app-data='{"userId":${ME},"csrf-token":"tok"}'><div class="user-link-name">seller</div></body></html>`);
        if (url.pathname === '/orders/trade') return res.end(`<html><body>${sales}</body></html>`);
        if (url.pathname === '/users/' + BUYER + '/') return res.end('<div class="param-item"><h5>Дата регистрации</h5><div>' + regText(10) + '<br>10 дней назад</div></div>');
        if (url.pathname.startsWith('/orders/YNG1')) return res.end('<div class="param-item"><h5>Количество</h5><div>300 шт.</div></div>');
        let b = '';
        req.on('data', (d) => (b += d));
        req.on('end', () => {
            const p = new URLSearchParams(b);
            res.setHeader('content-type', 'application/json');
            if (url.pathname === '/orders/refund') {
                refunds.push(p.get('id'));
                return res.end('{}');
            }
            if (url.pathname === '/runner/') {
                const reqv = p.get('request');
                if (reqv && reqv !== 'false') sent.push(JSON.parse(reqv).data.content);
                const objs = JSON.parse(p.get('objects'));
                return res.end(JSON.stringify({ objects: objs.map((o) => ({ type: 'chat_node', id: o.id, data: { messages: chat } })), response: {} }));
            }
            res.statusCode = 404;
            res.end();
        });
    });
    await new Promise((r) => srv.listen(0, r));
    const dir = mkdtempSync(join(tmpdir(), 'fp-refund-'));
    const child = spawn('node', ['funpay/poll.mjs'], {
        env: { ...process.env, FUNPAY_BASE: `http://127.0.0.1:${srv.address().port}`, FUNPAY_GOLDEN_KEY: 'test', FUNPAY_LIVE: '1', FUNPAY_POLL_MS: '200', FUNPAY_CHAT_MS: '200', FUNPAY_STATE_FILE: join(dir, 's.json'), FUNPAY_POLL_LOCK: join(dir, 'l.pid'), WS_URL: 'ws://127.0.0.1:1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    t.after(() => {
        child.kill();
        srv.close();
    });
    const until = async (cond, what) => {
        for (let i = 0; i < 100; i++) {
            if (cond()) return;
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`не дождались: ${what}\n${out}`);
    };
    await until(() => existsSync(join(dir, 's.json')), 'первый запуск');
    sales = row('YNG1', 'info', 'Монеты') + sales;
        await until(() => sent.some((s) => s.includes('Новорегам валюту не выдаём') && !/мошен|обман|подозр/i.test(s)), 'сообщение о возврате');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(refunds.length, 0, 'автовозврата новорегам нет');
    assert.equal(JSON.parse(readFileSync(join(dir, 's.json'), 'utf8')).orders.YNG1.phase, 'manual');
});
