import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.orchestrator.pid');

function pidAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Второй orchestrator.mjs → exit 2 (без спама в лог) */
export function acquireOrchestratorLock() {
    if (existsSync(LOCK_PATH)) {
        const pid = Number.parseInt(readFileSync(LOCK_PATH, 'utf8'), 10);
        if (pidAlive(pid)) {
            console.error(`[sellbot] уже запущен (pid ${pid}) — выход`);
            process.exit(2);
        }
        try {
            unlinkSync(LOCK_PATH);
        } catch {
            /* stale lock */
        }
    }

    writeFileSync(LOCK_PATH, String(process.pid));
    const cleanup = () => {
        try {
            if (existsSync(LOCK_PATH) && readFileSync(LOCK_PATH, 'utf8') === String(process.pid)) {
                unlinkSync(LOCK_PATH);
            }
        } catch {
            /* ignore */
        }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}
