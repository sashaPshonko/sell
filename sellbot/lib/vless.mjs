import { readFile } from 'fs/promises';

export function parseVlessUrlLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
        return null;
    }
    if (trimmed.startsWith('vless://')) {
        return trimmed;
    }
    const m = trimmed.match(/^VLESS_URL=(?:(['"])(.*?)\1|(\S+))/);
    return m?.[2] ?? m?.[3] ?? null;
}

function parseVlessParam(url, key) {
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const bare = query.split('#')[0];
    for (const part of bare.split('&')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq) === key) {
            return decodeURIComponent(part.slice(eq + 1));
        }
    }
    return '';
}

/** @returns {{ id, addr, port, security, sni, fp, pbk, sid, flow, network }} */
export function parseVlessUrl(vlessUrl) {
    const url = vlessUrl.trim();
    if (!url.startsWith('vless://')) {
        throw new Error('VLESS_URL должен начинаться с vless://');
    }

    const rest = url.slice('vless://'.length).split('#')[0];
    const id = rest.split('@')[0];
    const hostPart = rest.split('@')[1] || '';
    const addr = hostPart.split(':')[0];
    const portStr = hostPart.split(':')[1]?.split('?')[0] || '';
    const port = Number(portStr);

    const security = parseVlessParam(url, 'security') || 'reality';
    const network = parseVlessParam(url, 'type') || 'tcp';

    const parsed = {
        id,
        addr,
        port,
        security,
        sni: parseVlessParam(url, 'sni'),
        fp: parseVlessParam(url, 'fp'),
        pbk: parseVlessParam(url, 'pbk'),
        sid: parseVlessParam(url, 'sid'),
        flow: parseVlessParam(url, 'flow'),
        network,
    };

    if (!id || !addr || !port) {
        throw new Error('VLESS_URL: не хватает uuid, host или port');
    }
    if (security === 'reality') {
        for (const key of ['sni', 'fp', 'pbk', 'sid', 'flow']) {
            if (!parsed[key]) {
                throw new Error(`VLESS_URL: для Reality нужен параметр ${key}`);
            }
        }
    }

    return parsed;
}

export function buildXrayConfig(parsed, socksPort = 1080) {
    const user =
        parsed.security === 'reality'
            ? { id: parsed.id, encryption: 'none', flow: parsed.flow }
            : { id: parsed.id, encryption: 'none' };

    const streamSettings =
        parsed.security === 'reality'
            ? {
                  network: parsed.network,
                  security: 'reality',
                  realitySettings: {
                      fingerprint: parsed.fp,
                      serverName: parsed.sni,
                      publicKey: parsed.pbk,
                      shortId: parsed.sid,
                  },
              }
            : {
                  network: parsed.network,
                  security: 'none',
              };

    return {
        log: { loglevel: 'warning' },
        inbounds: [
            {
                listen: '127.0.0.1',
                port: socksPort,
                protocol: 'socks',
                settings: { auth: 'no', udp: true },
                tag: 'socks-in',
            },
        ],
        outbounds: [
            {
                protocol: 'vless',
                tag: 'proxy',
                settings: {
                    vnext: [
                        {
                            address: parsed.addr,
                            port: parsed.port,
                            users: [user],
                        },
                    ],
                },
                streamSettings,
            },
        ],
    };
}

export async function readVlessFromRepoFile(repoPath) {
    try {
        const raw = await readFile(repoPath, 'utf8');
        for (const line of raw.split('\n')) {
            const url = parseVlessUrlLine(line);
            if (url) return url;
        }
    } catch {
        /* ignore */
    }
    return null;
}

export async function readVlessFromEnvFile(envPath) {
    try {
        const env = await readFile(envPath, 'utf8');
        const m = env.match(/^VLESS_URL=(?:(['"])(.*?)\1|(\S+))/m);
        if (m?.[2] || m?.[3]) {
            return m[2] ?? m[3];
        }
    } catch {
        /* ignore */
    }
    return null;
}
