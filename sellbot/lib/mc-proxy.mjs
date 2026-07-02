import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';

/**
 * SOCKS5 для mineflayer.
 * @param {string|null|undefined} proxyString — socks5://user:pass@host:port или "off"
 * @returns {{ agent: import('socks-proxy-agent').SocksProxyAgent, connect: Function } | null}
 */
export function buildMcProxyConnect(proxyString) {
    const raw = String(proxyString ?? '').trim();
    if (!raw || raw === 'off') return null;

    const url = new URL(raw);
    const proxyHost = url.hostname;
    const proxyPort = Number(url.port);
    const proxyUsername = url.username || undefined;
    const proxyPassword = url.password || undefined;

    const agent = new SocksProxyAgent({
        protocol: 'socks5:',
        host: proxyHost,
        port: proxyPort,
        username: proxyUsername,
        password: proxyPassword,
    });

    const connect = (client) => {
        SocksClient.createConnection(
            {
                proxy: {
                    host: proxyHost,
                    port: proxyPort,
                    type: 5,
                    userId: proxyUsername,
                    password: proxyPassword,
                },
                command: 'connect',
                destination: {
                    host: 'mc.funtime.su',
                    port: 25565,
                },
            },
            (err, info) => {
                if (err) {
                    client.emit('error', err);
                    return;
                }
                client.setSocket(info.socket);
                client.emit('connect');
            },
        );
    };

    return { agent, connect };
}
