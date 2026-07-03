import { WebSocketServer } from 'ws';

const sellClients = new Set();
const eventQueue = [];

let wss;

function sendJson(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

/** События для sell (poll drainBotEvents) */
export function enqueueBotEvent(ev) {
    const stamped = { ...ev, at: new Date().toISOString() };
    eventQueue.push(stamped);
    const payload = JSON.stringify({ type: 'bot_event', event: stamped });
    for (const ws of sellClients) {
        if (ws.readyState === 1) ws.send(payload);
    }
}

export function drainBotEvents() {
    return eventQueue.splice(0, eventQueue.length);
}

function attachWsHandlers(handlers) {
    wss.on('connection', (ws) => {
        let role = null;

        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(String(raw));
            } catch {
                return;
            }

            if (msg?.type === 'register' && msg?.role === 'sell') {
                role = 'sell';
                sellClients.add(ws);
                sendJson(ws, { type: 'hello', role: 'sell' });
                console.log('[ws] sell подключился');
                return;
            }

            if (role !== 'sell') {
                return;
            }

            if (msg.type === 'order') {
                handlers.onOrder?.(msg);
            } else if (msg.type === 'nick_update') {
                handlers.onNickUpdate?.(msg.orderId, msg.nick);
            } else if (msg.type === 'cancel_order') {
                handlers.onCancel?.(msg.orderId);
            }
        });

        ws.on('close', () => {
            sellClients.delete(ws);
        });
    });
}

/** @returns {Promise<WebSocketServer>} exit code 2 при EADDRINUSE */
export function startWsServer(handlers = {}, port = 8790) {
    if (wss) return Promise.resolve(wss);

    return new Promise((resolve, reject) => {
        const server = new WebSocketServer({ port });

        server.once('listening', () => {
            wss = server;
            attachWsHandlers(handlers);
            console.log(`[ws] sellbot ws://0.0.0.0:${port}`);
            resolve(server);
        });

        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(
                    `[ws] порт ${port} занят — уже запущен sellbot:\n` +
                        `  kill $(lsof -t -i :${port})\n` +
                        `  или: bash kill.sh`,
                );
                const e = new Error(`EADDRINUSE:${port}`);
                e.code = 'EADDRINUSE';
                reject(e);
                return;
            }
            reject(err);
        });
    });
}

export function stopWsServer() {
    if (!wss) return;
    try {
        for (const ws of sellClients) {
            try { ws.close(); } catch { /* */ }
        }
        sellClients.clear();
        wss.close();
    } catch { /* */ }
    wss = undefined;
}
