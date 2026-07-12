import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';
import { unlink } from 'fs/promises';
import { constants, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';

const execAsync = promisify(exec);
const XRAY_LOCK = '/tmp/sellbot-telegram-proxy.lock';
const SELLBOT_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/lib$/, '');
const DEFAULT_XRAY_CMD = 'node xray.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveXrayCwd() {
    if (existsSync(join(SELLBOT_DIR, 'xray.mjs'))) return SELLBOT_DIR;
    if (existsSync(join(process.cwd(), 'xray.mjs'))) return process.cwd();
    if (existsSync(join(process.cwd(), 'sellbot', 'xray.mjs'))) {
        return join(process.cwd(), 'sellbot');
    }
    return SELLBOT_DIR;
}

/** tg.proxy / tg.telegramProxy: `off` | socks5h://... | http://... */
export function resolveTelegramProxyUrl(tg = {}) {
    const value = tg.proxy ?? tg.telegramProxy ?? 'off';
    if (value === 'off' || value === '0' || value === 'false' || !value) {
        return null;
    }
    return String(value);
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

async function runXrayCommand(tg) {
    const cmd = (tg.xrayCmd ?? tg.telegramXrayCmd)?.trim() || DEFAULT_XRAY_CMD;
    const cwd = resolveXrayCwd();
    console.log(`[Telegram] запуск прокси: ${cmd} (cwd=${cwd})`);
    const { stdout, stderr } = await execAsync(cmd, {
        cwd,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
    });
    if (stdout?.trim()) console.log(stdout.trim());
    if (stderr?.trim()) console.error(stderr.trim());
}

export async function ensureTelegramProxy(tg = {}) {
    const proxyUrl = resolveTelegramProxyUrl(tg);
    if (!proxyUrl) {
        console.log('[Telegram] без прокси (telegramProxy: off)');
        return true;
    }

    if (await isTelegramProxyReachable(proxyUrl)) {
        console.log(`[Telegram] прокси доступен: ${proxyUrl}`);
        return true;
    }

    const autoXray = tg.autoXray ?? tg.telegramAutoXray;
    if (!autoXray) {
        console.error(`[Telegram] прокси недоступен: ${proxyUrl}`);
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
        await runXrayCommand(tg);
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

export function buildTelegramBotOptions(tg = {}) {
    const proxyUrl = resolveTelegramProxyUrl(tg);
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

export function attachTelegramDiagnostics(bot, tg = {}) {
    bot.on('polling_error', async (error) => {
        const now = Date.now();
        if (now - lastPollingErrorLog < 30_000) {
            return;
        }
        lastPollingErrorLog = now;
        console.error('[Telegram polling_error]', error.code || '', error.message);

        const autoXray = tg.autoXray ?? tg.telegramAutoXray;
        if (autoXray && String(error.message).includes('ECONNREFUSED')) {
            await ensureTelegramProxy(tg);
        }
    });
}
