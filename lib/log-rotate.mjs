import fs from 'fs';
import path from 'path';

const DEFAULT_MAX = 80 * 1024 * 1024;
const DEFAULT_KEEP_DAYS = 14;

function listRotated(file) {
    const dir = path.dirname(file);
    const base = path.basename(file);
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((n) => n.startsWith(`${base}.`) && n !== base)
        .map((n) => path.join(dir, n));
}

export function rotateLogFile(file, { maxBytes = DEFAULT_MAX, keepDays = DEFAULT_KEEP_DAYS } = {}) {
    if (!file) return false;
    let st;
    try {
        st = fs.statSync(file);
    } catch {
        return false;
    }
    if (!st.isFile() || st.size < maxBytes) {
        pruneOld(file, keepDays);
        return false;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const dest = `${file}.${stamp}`;
    try {
        fs.copyFileSync(file, dest);
        fs.truncateSync(file, 0);
    } catch (err) {
        console.error(`[log-rotate] ${file}: ${err.message}`);
        return false;
    }
    pruneOld(file, keepDays);
    console.log(`[log-rotate] ${path.basename(file)} → ${path.basename(dest)}`);
    return true;
}

function pruneOld(file, keepDays) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const p of listRotated(file)) {
        try {
            if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
        } catch { /* ignore */ }
    }
}

export function pruneDirLogs(dir, { keepDays = DEFAULT_KEEP_DAYS, match = /\.log$/ } = {}) {
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return 0;
    }
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    let n = 0;
    for (const name of names) {
        if (!match.test(name)) continue;
        const p = path.join(dir, name);
        try {
            const st = fs.statSync(p);
            if (st.isFile() && st.mtimeMs < cutoff) {
                fs.unlinkSync(p);
                n++;
            }
        } catch { /* ignore */ }
    }
    return n;
}

export function startLogRotate(files, opts = {}) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
    const intervalMs = opts.intervalMs ?? 30 * 60 * 1000;
    const tick = () => {
        for (const f of list) rotateLogFile(f, opts);
        if (opts.dir) pruneDirLogs(opts.dir, opts);
    };
    tick();
    const t = setInterval(tick, intervalMs);
    t.unref?.();
    return () => clearInterval(t);
}
