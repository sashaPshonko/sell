import WebSocket from 'ws';
import { audit } from './audit.mjs';

const pendingOrders = [];
const pendingNickUpdates = [];
const pendingCancels = [];
let ws;
let connected = false;
const eventQueue = [];

function connect() {
    const url = process.env.WS_URL || 'ws://127.0.0.1:8790';
    if (process.env.WS_DISABLE === '1') return;

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    ws = new WebSocket(url);

    ws.on('open', () => {
        connected = true;
        ws.send(JSON.stringify({ type: 'register', role: 'sell' }));
        console.log(`[ws-client] подключён ${url}`);
        flushPending();
    });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'bot_event' && msg.event?.orderId) {
                eventQueue.push(msg.event);
                void audit('ws_recv', msg.event);
            }
        } catch {
            /* ignore */
        }
    });

    ws.on('close', () => {
        connected = false;
        console.warn('[ws-client] отключён, переподключение через 3с');
        setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
        console.warn('[ws-client]', err.message);
    });
}

function flushPending() {
    while (pendingOrders.length) {
        const order = pendingOrders.shift();
        ws.send(JSON.stringify({ type: 'order', ...order }));
    }
    while (pendingNickUpdates.length) {
        const { orderId, nick } = pendingNickUpdates.shift();
        ws.send(JSON.stringify({ type: 'nick_update', orderId, nick }));
    }
    while (pendingCancels.length) {
        const orderId = pendingCancels.shift();
        ws.send(JSON.stringify({ type: 'cancel_order', orderId }));
    }
}

function sendWhenReady(payload) {
    if (connected && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

export function startWsClient() {
    connect();
}

export function pushOrder(order) {
    const payload = { type: 'order', ...order };
    if (!sendWhenReady(payload)) {
        pendingOrders.push(order);
        connect();
        void audit('ws_queue', { orderId: order.orderId, nick: order.nick, amountKk: order.amount });
        console.warn(`[ws-client] sellbot офлайн — в очереди ${order.orderId}`);
    } else {
        void audit('ws_sent', { orderId: order.orderId, nick: order.nick, amountKk: order.amount });
        console.log(`[ws-client] заказ ${order.orderId}`);
    }
    return { sent: connected ? 1 : 0 };
}

export function pushNickUpdate(orderId, nick) {
    const payload = { type: 'nick_update', orderId, nick };
    if (!sendWhenReady(payload)) {
        pendingNickUpdates.push({ orderId, nick });
        connect();
    }
}

export function pushCancelOrder(orderId) {
    const payload = { type: 'cancel_order', orderId };
    if (!sendWhenReady(payload)) {
        pendingCancels.push(orderId);
        connect();
    } else {
        console.log(`[ws-client] отмена ${orderId}`);
    }
}

export function drainBotEvents() {
    return eventQueue.splice(0, eventQueue.length);
}
