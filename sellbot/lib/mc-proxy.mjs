import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';

/**
 * @param {string} proxyString
 * @returns {{ host: string, port: number, userId?: string, password?: string }}
 */
function parseSocksUrl(proxyString) {
    const url = new URL(String(proxyString).trim());
    return {
        host: url.hostname,
        port: Number(url.port),
        userId: url.username || undefined,
        password: url.password || undefined,
    };
}

/**
 * SOCKS5 для mineflayer.
 * Цепочка: [proxyVia / xray] → proxy → mc.funtime.su
 * Нужно, когда VPS провайдер режет прямой доступ к внешнему SOCKS.
 *
 * @param {string|null|undefined} proxyString — socks5://user:pass@host:port или "off"
 * @param {string|null|undefined} viaString — socks5://127.0.0.1:1080 (xray) или "off"/пусто
 * @returns {{ agent: import('socks-proxy-agent').SocksProxyAgent, connect: Function } | null}
 */
export function buildMcProxyConnect(proxyString, viaString) {
    const raw = String(proxyString ?? '').trim();
    if (!raw || raw === 'off') return null;

    const remote = parseSocksUrl(raw);
    const viaRaw = String(viaString ?? '').trim();
    const useVia = Boolean(viaRaw && viaRaw !== 'off');
    const via = useVia ? parseSocksUrl(viaRaw) : null;

    /** @type {import('socks-proxy-agent').SocksProxyAgent} */
    let agent;
    if (via) {
        const viaAgent = new SocksProxyAgent({
            protocol: 'socks5:',
            host: via.host,
            port: via.port,
            username: via.userId,
            password: via.password,
        });
        agent = new SocksProxyAgent(
            {
                protocol: 'socks5:',
                host: remote.host,
                port: remote.port,
                username: remote.userId,
                password: remote.password,
            },
            { agent: viaAgent },
        );
    } else {
        agent = new SocksProxyAgent({
            protocol: 'socks5:',
            host: remote.host,
            port: remote.port,
            username: remote.userId,
            password: remote.password,
        });
    }

    const connect = (client) => {
        const fail = (err) => client.emit('error', err);
        const attach = (socket) => {
            client.setSocket(socket);
            client.emit('connect');
        };

        const connectRemote = (existingSocket) => {
            SocksClient.createConnection(
                {
                    ...(existingSocket ? { existing_socket: existingSocket } : {}),
                    proxy: {
                        host: remote.host,
                        port: remote.port,
                        type: 5,
                        userId: remote.userId,
                        password: remote.password,
                    },
                    command: 'connect',
                    destination: {
                        host: 'mc.funtime.su',
                        port: 25565,
                    },
                },
                (err, info) => {
                    if (err) {
                        fail(err);
                        return;
                    }
                    attach(info.socket);
                },
            );
        };

        if (!via) {
            connectRemote(null);
            return;
        }

        // 1) VPS → xray → TCP до внешнего SOCKS
        SocksClient.createConnection(
            {
                proxy: {
                    host: via.host,
                    port: via.port,
                    type: 5,
                    userId: via.userId,
                    password: via.password,
                },
                command: 'connect',
                destination: {
                    host: remote.host,
                    port: remote.port,
                },
            },
            (err, info) => {
                if (err) {
                    fail(err);
                    return;
                }
                // 2) на этом сокете — SOCKS5 к прокси → MC
                connectRemote(info.socket);
            },
        );
    };

    return { agent, connect };
}

const BOT_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bot.json');

/** Прокси из bot.json — не зависит от workerData оркестратора */
export function readBotJsonProxy() {
    try {
        const arr = JSON.parse(readFileSync(BOT_JSON_PATH, 'utf-8'));
        return String(arr[0]?.proxy ?? '').trim();
    } catch {
        return '';
    }
}

/** Локальный xray/SOCKS, через который идём к proxy */
export function readBotJsonProxyVia() {
    try {
        const arr = JSON.parse(readFileSync(BOT_JSON_PATH, 'utf-8'));
        return String(arr[0]?.proxyVia ?? '').trim();
    } catch {
        return '';
    }
}

export function maskProxyUrl(proxyString) {
    try {
        const url = new URL(String(proxyString));
        return `${url.hostname}:${url.port}`;
    } catch {
        return '?';
    }
}
