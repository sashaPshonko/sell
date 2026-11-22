import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ME = 900;
const BUYER = 777;
const OTHER = 555;

test('автоответ: «можно купить?» без заказа — отвечаем один раз; если продавец уже ответил — молчим', async (t) => {
    const sent = [];
    // чат 111 (покупатель BUYER), чат 222 (OTHER)
    const msgs = { 111: [{ id: 10, author: BUYER, text: 'старое' }], 222: [{ id: 20, author: OTHER, text: 'старое' }] };
    const names = { 111: `users-${BUYER}-${ME}`, 222: `users-${OTHER}-${ME}` };
    const item = (id) => {
        const last = msgs[id].at(-1);
        return `<a class="contact-item" data-id="${id}" data-node-msg="${last.id}"><div class="media-user-name">u${id}</div><div class="contact-item-message">${last.text}</div></a>`;
    };
    const html = (m) => `<div class="chat-msg-item"><div class="chat-msg-text">${m.text}</div></div>`;
    let nextId = 100;
    const srv = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/') return res.end(`<html><body data-app-data='{"userId":${ME},"csrf-token":"tok"}'><div class="user-link-name">seller</div></body></html>`);
        if (url.pathname === '/orders/trade') return res.end('<html><body></body></html>');
        let b = '';
        req.on('data', (d) => (b += d));
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            if (url.pathname !== '/runner/') return res.end('{}');
            const p = new URLSearchParams(b);
            const reqv = p.get('request');
            if (reqv && reqv !== 'false') {
                const r = JSON.parse(reqv);
                sent.push({ node: r.data.node, text: r.data.content });
                const id = Number(Object.keys(names).find((k) => names[k] === r.data.node));
                msgs[id].push({ id: nextId++, author: ME, text: r.data.content });
            }
            const o = JSON.parse(p.get('objects'))[0];
            if (o.type === 'chat_bookmarks') {
                return res.end(JSON.stringify({ objects: [{ type: 'chat_bookmarks', data: { html: item(111) + item(222) } }], response: {} }));
            }
            const id = Number(o.id) || Number(Object.keys(names).find((k) => names[k] === o.id));
            const last = Number(o.data.last_message);
            return res.end(
                JSON.stringify({
                    objects: [{ type: 'chat_node', id: o.id, data: { node: { id, name: names[id] }, messages: msgs[id].filter((m) => m.id > last).map((m) => ({ id: m.id, author: m.author, html: html(m) })) } }],
                    response: {},
                }),
            );
        });
    });
    await new Promise((r) => srv.listen(0, r));
    const dir = mkdtempSync(join(tmpdir(), 'fp-auto-'));
    const child = spawn('node', ['funpay/poll.mjs'], {
        env: { ...process.env, FUNPAY_BASE: `http://127.0.0.1:${srv.address().port}`, FUNPAY_GOLDEN_KEY: 'test', FUNPAY_LIVE: '1', FUNPAY_POLL_MS: '200', FUNPAY_CHAT_MS: '200', FUNPAY_CHATLIST_MS: '200', FUNPAY_STATE_FILE: join(dir, 's.json'), FUNPAY_POLL_LOCK: join(dir, 'l.pid'), WS_URL: 'ws://127.0.0.1:1' },
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
    await until(() => existsSync(join(dir, 's.json')), 'старт');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(sent.length, 0, 'старые сообщения не трогаем');

    // покупатель пишет вопрос → автоответ
    msgs[111].push({ id: nextId++, author: BUYER, text: 'ку купить можно?' });
    await until(() => sent.length === 1, 'автоответ');
    assert.equal(sent[0].node, names[111]);
    assert.match(sent[0].text, /Автоответ\. Если лот открыт/);
    assert.match(sent[0].text, /выдача автоматическая/);
    assert.match(sent[0].text, /Выдача через \/pay, без банов/);

    // второй вопрос сразу — кулдаун, молчим
    msgs[111].push({ id: nextId++, author: BUYER, text: 'алё' });
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(sent.length, 1, 'кулдаун');

    // другой чат: покупатель пишет, но продавец успевает ответить сам → молчим
    msgs[222].push({ id: nextId++, author: OTHER, text: 'можно?' }, { id: nextId++, author: ME, text: 'да' });
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(sent.length, 1, 'продавец ответил сам');
});
