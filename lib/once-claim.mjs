import { closeSync, existsSync, mkdirSync, openSync } from 'fs';
import { join } from 'path';

/** Общий между копиями репо / двумя poll (не привязан к cwd). */
const CLAIMS_DIR = process.env.ONCE_CLAIMS_DIR || '/tmp/sell-once-claims';

/**
 * Атомарный once-claim (wx). Повтор с тем же key → false.
 * @param {string} bucket
 * @param {string} key
 */
export function tryOnceClaim(bucket, key) {
    const safeBucket = String(bucket || 'misc').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeKey = String(key || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safeKey) return false;

    const dir = join(CLAIMS_DIR, safeBucket);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safeKey);
    if (existsSync(path)) return false;
    try {
        const fd = openSync(path, 'wx');
        closeSync(fd);
        return true;
    } catch (err) {
        if (err?.code === 'EEXIST') return false;
        throw err;
    }
}
