import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'fs';

function pidAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Один процесс на lock-файл. Второй → exit 2. */
export function acquirePidLock(lockPath, label = 'sell') {
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
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}
