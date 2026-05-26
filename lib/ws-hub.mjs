import { WebSocketServer } from 'ws';

const clients = new Set();
const eventQueue = [];

let wss;

/**
 * События от бота (подключение к ws://host:port):
 * { type: 'delivery_ok'|'delivery_failed'|'invalid_nick'|'player_offline'|'nick_updated', orderId, nick?, reason? }
 *
 * Заказ от sell → всем ботам:
 * { type: 'order', orderId, dealId, chatId, buyer, nick, amount, anarchy, itemName }
 */
export function startWsHub(port = Number(process.env.WS_PORT || 8790)) {
    if (wss) return wss;

    wss = new WebSocketServer({ port });
    console.log(`[ws] сервер ws://0.0.0.0:${port}`);

    wss.on('connection', (ws) => {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'hello', role: 'bot' }));
        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(String(raw));
                if (!msg?.type || !msg?.orderId) return;
                eventQueue.push({ ...msg, at: new Date().toISOString() });
            } catch {
                /* ignore */
            }
        });
        ws.on('close', () => clients.delete(ws));
    });

    return wss;
}

export function pushOrder(order) {
    const payload = JSON.stringify({ type: 'order', ...order });
    let n = 0;
    for (const ws of clients) {
        if (ws.readyState === 1) {
            ws.send(payload);
            n++;
        }
    }
    if (!n) {
        console.warn('[ws] нет подключённых ботов — заказ в очереди лога');
        console.log('[ws] order:', JSON.stringify(order));
    } else {
        console.log(`[ws] заказ ${order.orderId} → ${n} бот(ов)`);
    }
    return { sent: n };
}

export function pushNickUpdate(orderId, nick) {
    const payload = JSON.stringify({ type: 'nick_update', orderId, nick });
    for (const ws of clients) {
        if (ws.readyState === 1) ws.send(payload);
    }
}

export function drainBotEvents() {
    return eventQueue.splice(0, eventQueue.length);
}
