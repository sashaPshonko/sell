import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'fs';
import { execSync } from 'child_process';

function pidAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readLockPid(lockPath) {
    if (!existsSync(lockPath)) return 0;
    return Number.parseInt(readFileSync(lockPath, 'utf8'), 10) || 0;
}

function cleanupStaleLock(lockPath) {
    const pid = readLockPid(lockPath);
    if (!pid || pidAlive(pid)) return pid;
    try {
        unlinkSync(lockPath);
    } catch {
        /* ignore */
    }
    return 0;
}

function listMatchingPids(pattern, selfPid = process.pid) {
    try {
        const out = execSync(`pgrep -f ${JSON.stringify(pattern)}`, { encoding: 'utf8' });
        return out
            .trim()
            .split('\n')
            .map((line) => Number.parseInt(line, 10))
            .filter((pid) => pid && pid !== selfPid);
    } catch (err) {
        if (err?.status === 1) return [];
        return [];
    }
}

/** Убить orchestrator/poll без живого lock-файла (после kill -9, дубль nohup и т.п.) */
function reclaimOrphans(pattern, lockPath, label) {
    const lockPid = cleanupStaleLock(lockPath);
    for (const pid of listMatchingPids(pattern)) {
        if (pid === lockPid && pidAlive(pid)) continue;
        if (!pidAlive(pid)) continue;
        console.warn(`[${label}] сирота pid ${pid} — SIGKILL`);
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            /* ignore */
        }
    }
    cleanupStaleLock(lockPath);
}

/**
 * Один процесс на lock-файл. Второй живой holder → exit 2.
 * @param {string} lockPath
 * @param {string} [label]
 * @param {{ processPattern?: string }} [opts]
 */
export function acquirePidLock(lockPath, label = 'sell', opts = {}) {
    const { processPattern } = opts;

    if (processPattern) {
        reclaimOrphans(processPattern, lockPath, label);
        const others = listMatchingPids(processPattern);
        if (others.length) {
            const pid = others[0];
            console.error(`[${label}] уже запущен (pid ${pid}) — выход`);
            process.exit(2);
        }
    } else {
        cleanupStaleLock(lockPath);
    }

    const held = readLockPid(lockPath);
    if (held && pidAlive(held)) {
        console.error(`[${label}] уже запущен (pid ${held}) — выход`);
        process.exit(2);
    }
    if (held) {
        try {
            unlinkSync(lockPath);
        } catch {
            /* stale */
        }
    }

    try {
        const fd = openSync(lockPath, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
    } catch (err) {
        if (err?.code === 'EEXIST') {
            const heldAgain = readLockPid(lockPath);
            if (heldAgain && pidAlive(heldAgain)) {
                console.error(`[${label}] уже запущен (pid ${heldAgain}) — выход`);
                process.exit(2);
            }
            try {
                unlinkSync(lockPath);
            } catch {
                /* ignore */
            }
            const fd = openSync(lockPath, 'wx');
            writeSync(fd, String(process.pid));
            closeSync(fd);
        } else {
            throw err;
        }
    }

    const cleanup = () => {
        try {
            if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === String(process.pid)) {
                unlinkSync(lockPath);
            }
        } catch {
            /* ignore */
        }
    };
    process.on('exit', cleanup);
}

export function releasePidLock(lockPath) {
    try {
        if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === String(process.pid)) {
            unlinkSync(lockPath);
        }
    } catch {
        /* ignore */
    }
}
