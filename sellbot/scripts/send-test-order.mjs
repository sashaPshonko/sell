/**
 * Проверка MOCK_DELIVERY / sellbot WS без PlayerOK.
 *
 * Терминал 1: npm run start:mock
 * Терминал 2: npm run test-order
 */
import WebSocket from 'ws';
import { DELIVERY_ANARCHY_NUM } from '../../config.mjs';

const url = process.env.WS_URL || 'ws://127.0.0.1:8790';
const orderId = process.env.TEST_ORDER_ID || `test-${Date.now()}`;
const nick = process.env.TEST_NICK || 'Steve';
const amount = Number(process.env.TEST_AMOUNT || 100);

const order = {
    type: 'order',
    orderId,
    nick,
    amount,
    buyer: 'test-buyer',
    paidAtMs: Date.now(),
    anarchy: DELIVERY_ANARCHY_NUM,
};

const ws = new WebSocket(url);

const timeout = setTimeout(() => {
    console.error('Таймаут 10с: нет delivery_ok. Запущен npm run start:mock?');
    process.exit(1);
}, 10000);

ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'register', role: 'sell' }));
    console.log(`[test-order] → order ${orderId.slice(0, 8)}… ${nick} ${amount}kk`);
    ws.send(JSON.stringify(order));
});

ws.on('message', (raw) => {
    let msg;
    try {
        msg = JSON.parse(String(raw));
    } catch {
        return;
    }
    console.log('[test-order] ←', msg);

    const ev = msg.type === 'bot_event' ? msg.event : null;
    if (ev?.orderId === orderId && ev.type === 'delivery_ok') {
        clearTimeout(timeout);
        console.log('OK: delivery_ok');
        ws.close();
        process.exit(0);
    }
});

ws.on('error', (err) => {
    console.error(err.message);
    process.exit(1);
});
