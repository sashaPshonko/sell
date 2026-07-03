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

function findOtherProcess(pattern) {
    try {
        const out = execSync(`pgrep -f ${JSON.stringify(pattern)}`, { encoding: 'utf8' });
        for (const line of out.trim().split('\n')) {
            const pid = Number.parseInt(line, 10);
            if (pid && pid !== process.pid) return pid;
        }
    } catch (err) {
        if (err?.status === 1) return null;
    }
    return null;
}

/**
 * Один процесс на lock-файл. Второй → exit 2.
 * @param {string} lockPath
 * @param {string} [label]
 * @param {{ processPattern?: string }} [opts] — pgrep до lock-файла (старый процесс без .pid)
 */
export function acquirePidLock(lockPath, label = 'sell', opts = {}) {
    const { processPattern } = opts;
    if (processPattern) {
        const other = findOtherProcess(processPattern);
        if (other) {
            console.error(`[${label}] уже запущен (pid ${other}) — выход`);
            process.exit(2);
        }
    }
    if (existsSync(lockPath)) {
        const pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
        if (pidAlive(pid)) {
            console.error(`[${label}] уже запущен (pid ${pid}) — выход`);
            process.exit(2);
        }
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
            console.error(`[${label}] уже запущен — выход`);
            process.exit(2);
        }
        throw err;
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
