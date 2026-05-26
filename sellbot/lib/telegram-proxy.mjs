import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, unlink } from 'fs/promises';
import { constants } from 'fs';
import { SocksProxyAgent } from 'socks-proxy-agent';

const execAsync = promisify(exec);
const XRAY_LOCK = '/tmp/sellbot-telegram-proxy.lock';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** TELEGRAM_PROXY=socks5h://127.0.0.1:1080 | http://127.0.0.1:1080 | off */
export function resolveTelegramProxyUrl() {
    const value = process.env.TELEGRAM_PROXY;
    if (value === 'off' || value === '0' || value === 'false') {
        return null;
    }
    return value || 'socks5h://127.0.0.1:1080';
}

function parseProxyHostPort(proxyUrl) {
    const normalized = proxyUrl
        .replace(/^socks5h?:\/\//i, 'http://')
        .replace(/^socks5:\/\//i, 'http://');
    const url = new URL(normalized);
    return {
        host: url.hostname,
        port: Number(url.port || 1080),
    };
}

export function isTelegramProxyReachable(proxyUrl, timeoutMs = 2000) {
    const { host, port } = parseProxyHostPort(proxyUrl);
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function runXrayCommand() {
    const cmd = process.env.TELEGRAM_XRAY_CMD?.trim();
    if (!cmd) {
        throw new Error('задай TELEGRAM_XRAY_CMD (команда поднятия SOCKS на сервере)');
    }
    console.log(`[Telegram] запуск прокси: ${cmd}`);
    const { stdout, stderr } = await execAsync(cmd, {
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
    });
    if (stdout?.trim()) console.log(stdout.trim());
    if (stderr?.trim()) console.error(stderr.trim());
}

export async function ensureTelegramProxy() {
    const proxyUrl = resolveTelegramProxyUrl();
    if (!proxyUrl) {
        console.log('[Telegram] без прокси (TELEGRAM_PROXY=off)');
        return true;
    }

    if (await isTelegramProxyReachable(proxyUrl)) {
        console.log(`[Telegram] прокси доступен: ${proxyUrl}`);
        return true;
    }

    if (process.env.TELEGRAM_AUTO_XRAY === 'off') {
        console.error(`[Telegram] прокси недоступен: ${proxyUrl} (TELEGRAM_AUTO_XRAY=off)`);
        return false;
    }

    if (!process.env.TELEGRAM_XRAY_CMD?.trim()) {
        console.error(
            `[Telegram] прокси ${proxyUrl} недоступен. Подними SOCKS на сервере или TELEGRAM_PROXY=off`,
        );
        return false;
    }

    let lockFd;
    try {
        const { open } = await import('fs/promises');
        lockFd = await open(XRAY_LOCK, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch {
        console.log('[Telegram] прокси уже поднимается другим процессом, жду…');
        for (let i = 0; i < 24; i++) {
            await sleep(5000);
            if (await isTelegramProxyReachable(proxyUrl)) {
                console.log(`[Telegram] прокси поднялся: ${proxyUrl}`);
                return true;
            }
        }
        console.error('[Telegram] таймаут ожидания прокси');
        return false;
    }

    try {
        if (await isTelegramProxyReachable(proxyUrl)) {
            return true;
        }
        await runXrayCommand();
        for (let i = 0; i < 12; i++) {
            await sleep(2000);
            if (await isTelegramProxyReachable(proxyUrl)) {
                console.log(`[Telegram] прокси готов: ${proxyUrl}`);
                return true;
            }
        }
        console.error('[Telegram] команда отработала, порт всё ещё недоступен');
        return false;
    } catch (error) {
        console.error('[Telegram] не удалось поднять прокси:', error.message);
        return false;
    } finally {
        try {
            await lockFd?.close();
        } catch {}
        await unlink(XRAY_LOCK).catch(() => {});
    }
}

export function buildTelegramBotOptions() {
    const proxyUrl = resolveTelegramProxyUrl();
    if (!proxyUrl) {
        return { polling: true };
    }

    const lower = proxyUrl.toLowerCase();
    const request = {};

    if (lower.startsWith('http://') || lower.startsWith('https://')) {
        request.proxy = proxyUrl;
    } else {
        request.agent = new SocksProxyAgent(proxyUrl);
    }

    return { polling: true, request };
}

let lastPollingErrorLog = 0;

export function attachTelegramDiagnostics(bot) {
    bot.on('polling_error', async (error) => {
        const now = Date.now();
        if (now - lastPollingErrorLog < 30_000) {
            return;
        }
        lastPollingErrorLog = now;
        console.error('[Telegram polling_error]', error.code || '', error.message);

        if (
            process.env.TELEGRAM_AUTO_XRAY !== 'off' &&
            String(error.message).includes('ECONNREFUSED')
        ) {
            await ensureTelegramProxy();
        }
    });
}
