import { execFile } from 'child_process';
import { promisify } from 'util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';

const execFileAsync = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const XRAY_SCRIPT = join(ROOT, '..', 'xray.mjs');

function portOpen(port, host = '127.0.0.1', timeoutMs = 2000) {
    return new Promise((resolve) => {
        const s = net.connect({ host, port });
        const done = (ok) => {
            s.destroy();
            resolve(ok);
        };
        s.setTimeout(timeoutMs);
        s.once('connect', () => done(true));
        s.once('timeout', () => done(false));
        s.once('error', () => done(false));
    });
}

function viaSocksPort(viaString) {
    const raw = String(viaString ?? '').trim();
    if (!raw || raw === 'off') return null;
    try {
        const u = new URL(raw.replace(/^socks5h:/i, 'socks5:'));
        const host = u.hostname || '127.0.0.1';
        if (host !== '127.0.0.1' && host !== 'localhost') {
            // внешний via — не наш xray
            return null;
        }
        return Number(u.port || 1080);
    } catch {
        return null;
    }
}

/**
 * Если в bot.json proxyVia → 127.0.0.1:1080 и порт закрыт — поднимаем xray.mjs.
 * @param {string} viaString
 * @returns {Promise<boolean>}
 */
export async function ensureMcProxyVia(viaString) {
    const port = viaSocksPort(viaString);
    if (port == null) {
        return true;
    }

    if (await portOpen(port)) {
        console.log(`[xray] proxyVia :${port} уже ок`);
        return true;
    }

    console.log(`[xray] :${port} закрыт — запускаю node xray.mjs`);
    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [XRAY_SCRIPT], {
            cwd: join(ROOT, '..'),
            timeout: 180_000,
            maxBuffer: 10 * 1024 * 1024,
        });
        if (stdout?.trim()) console.log(stdout.trim());
        if (stderr?.trim()) console.error(stderr.trim());
    } catch (e) {
        console.error(`[xray] не поднялся: ${e.message}`);
        if (e.stdout) console.error(String(e.stdout).slice(-2000));
        if (e.stderr) console.error(String(e.stderr).slice(-2000));
        return false;
    }

    for (let i = 0; i < 10; i++) {
        if (await portOpen(port)) {
            console.log(`[xray] ✅ :${port} слушается`);
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    console.error(`[xray] после xray.mjs порт :${port} всё ещё закрыт`);
    return false;
}
