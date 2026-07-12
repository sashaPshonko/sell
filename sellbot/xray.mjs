#!/usr/bin/env node
/**
 * Xray → SOCKS 127.0.0.1:1080 для sellbot (MC proxyVia + Telegram).
 * Ссылка: vless.url в этом каталоге (git). Без .env.
 *
 *   node xray.mjs
 *   node xray-check.mjs
 */
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import {
    access,
    mkdir,
    readFile,
    writeFile,
    chmod,
    open,
    constants,
} from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'os';
import {
    parseVlessUrl,
    buildXrayConfig,
    readVlessFromRepoFile,
} from './lib/vless.mjs';
import { SocksProxyAgent } from 'socks-proxy-agent';

const execFileAsync = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(ROOT, '.xray-runtime');
const VLESS_REPO_FILE = join(ROOT, 'vless.url');
const STAMP_FILE = join(ROOT, '.vless-applied.stamp');
const PID_FILE = join(RUNTIME, 'xray.pid');
/** Фиксированный порт — совпадает с proxyVia в bot.json */
const SOCKS_PORT = 1080;
const PROXY_URL = `socks5h://127.0.0.1:${SOCKS_PORT}`;

function xrayAssetName() {
    const p = platform();
    const a = arch();
    if (p === 'win32') {
        return a === 'arm64' ? 'Xray-windows-arm64-v8a.zip' : 'Xray-windows-64.zip';
    }
    if (p === 'darwin') {
        return a === 'arm64' ? 'Xray-macos-arm64-v8a.zip' : 'Xray-macos-64.zip';
    }
    if (a === 'arm64') return 'Xray-linux-arm64-v8a.zip';
    return 'Xray-linux-64.zip';
}

function xrayBinaryName() {
    return platform() === 'win32' ? 'xray.exe' : 'xray';
}

function paths() {
    const bin = join(RUNTIME, xrayBinaryName());
    return {
        bin,
        config: join(RUNTIME, 'config.json'),
        log: join(RUNTIME, 'xray.log'),
        zip: join(RUNTIME, xrayAssetName()),
    };
}

async function readDesiredVlessUrl() {
    const fromRepo = await readVlessFromRepoFile(VLESS_REPO_FILE);
    if (fromRepo) return fromRepo;
    throw new Error('Нет sellbot/vless.url — положи vless://… в файл и закоммить');
}

async function downloadXray(zipPath, assetName) {
    console.log(`[xray] скачиваем ${assetName}…`);
    const api = await fetch('https://api.github.com/repos/XTLS/Xray-core/releases/latest');
    if (!api.ok) {
        throw new Error(`GitHub releases: HTTP ${api.status}`);
    }
    const release = await api.json();
    const asset = release.assets?.find((a) => a.name === assetName);
    if (!asset?.browser_download_url) {
        throw new Error(`Нет ассета ${assetName}`);
    }
    const res = await fetch(asset.browser_download_url);
    if (!res.ok) {
        throw new Error(`Скачивание: HTTP ${res.status}`);
    }
    await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
}

async function extractZip(zipPath, destDir) {
    const p = platform();
    if (p === 'win32') {
        await execFileAsync(
            'powershell',
            [
                '-NoProfile',
                '-Command',
                `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`,
            ],
            { timeout: 120_000 },
        );
        return;
    }
    try {
        await execFileAsync('unzip', ['-o', zipPath, '-d', destDir], { timeout: 120_000 });
    } catch {
        await execFileAsync('tar', ['-xf', zipPath, '-C', destDir], { timeout: 120_000 });
    }
}

async function ensureBinary() {
    const { bin, zip } = paths();
    try {
        await access(bin, platform() === 'win32' ? constants.F_OK : constants.X_OK);
        return bin;
    } catch {
        /* download */
    }

    await mkdir(RUNTIME, { recursive: true });
    const assetName = xrayAssetName();
    await downloadXray(zip, assetName);
    await extractZip(zip, RUNTIME);
    if (platform() !== 'win32') {
        await chmod(bin, 0o755);
    }
    return bin;
}

async function stopXray() {
    try {
        const pid = Number((await readFile(PID_FILE, 'utf8')).trim());
        if (pid > 0) {
            try {
                process.kill(pid, 'SIGTERM');
            } catch {
                /* already dead */
            }
        }
    } catch {
        /* no pid */
    }
    if (platform() === 'win32') {
        try {
            await execFileAsync('taskkill', ['/F', '/IM', xrayBinaryName()], { timeout: 10_000 });
        } catch {
            /* not running */
        }
        return;
    }
    // только наш бинарь из runtime, не чужой xray на машине
    const { bin } = paths();
    try {
        const { stdout } = await execFileAsync('pgrep', ['-f', bin], { timeout: 5000 });
        for (const line of stdout.trim().split('\n')) {
            const pid = Number(line.trim());
            if (pid > 0) {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch {
                    /* ignore */
                }
            }
        }
    } catch {
        /* none */
    }
}

async function writeConfig(vlessUrl) {
    const parsed = parseVlessUrl(vlessUrl);
    console.log(
        `[xray] server=${parsed.addr}:${parsed.port} security=${parsed.security} network=${parsed.network}`,
    );
    const config = buildXrayConfig(parsed, SOCKS_PORT);
    const { config: configPath } = paths();
    await mkdir(RUNTIME, { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2));
    return configPath;
}

async function testConfig(bin, configPath) {
    console.log('[xray] проверка конфига…');
    const { stdout, stderr } = await execFileAsync(bin, ['run', '-test', '-c', configPath], {
        timeout: 30_000,
    });
    const out = `${stdout || ''}${stderr || ''}`.trim();
    if (out) console.log(out);
}

async function startXrayProcess(bin, configPath) {
    const { log } = paths();
    console.log('[xray] запуск…');
    await stopXray();
    await new Promise((r) => setTimeout(r, 800));

    const logFd = await open(log, 'a');
    const child = spawn(bin, ['run', '-c', configPath], {
        detached: true,
        stdio: ['ignore', logFd.fd, logFd.fd],
        windowsHide: true,
    });
    child.unref();
    await logFd.close();
    if (child.pid) {
        await writeFile(PID_FILE, String(child.pid));
    }
    await new Promise((r) => setTimeout(r, 2000));
}

async function isPortOpen(port, host = '127.0.0.1', timeoutMs = 2000) {
    const net = await import('net');
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

async function isTelegramApiOkViaProxy(proxyUrl) {
    try {
        const agent = new SocksProxyAgent(proxyUrl);
        const res = await fetch('https://api.telegram.org', {
            agent,
            signal: AbortSignal.timeout(12_000),
        });
        return res.status > 0;
    } catch {
        return false;
    }
}

async function main() {
    if (await isPortOpen(SOCKS_PORT)) {
        console.log(`[xray] :${SOCKS_PORT} уже слушается — ок`);
        return;
    }

    const vlessUrl = await readDesiredVlessUrl();
    const bin = await ensureBinary();
    const configPath = await writeConfig(vlessUrl);
    await testConfig(bin, configPath);
    await startXrayProcess(bin, configPath);

    if (!(await isPortOpen(SOCKS_PORT))) {
        const { log } = paths();
        let tail = '';
        try {
            tail = (await readFile(log, 'utf8')).split('\n').slice(-40).join('\n');
        } catch {
            /* empty */
        }
        console.error(`[xray] порт ${SOCKS_PORT} не слушается`);
        if (tail) console.error(tail);
        process.exit(1);
    }

    console.log(`[xray] ✅ SOCKS 127.0.0.1:${SOCKS_PORT}`);
    if (await isTelegramApiOkViaProxy(PROXY_URL)) {
        console.log('[xray] ✅ Telegram API через SOCKS OK');
    } else {
        console.warn('[xray] SOCKS есть, Telegram не ответил — node xray-check.mjs');
    }

    await writeFile(STAMP_FILE, vlessUrl, { mode: 0o600 });
}

main().catch((e) => {
    console.error(`[xray] ❌ ${e.message}`);
    process.exit(1);
});
