/** Глобальная очередь publishItem — один лот за раз, пауза после rate-limit. */

let rateLimitUntil = 0;
let lastRunAt = 0;

/** @type {Map<string, { runAt: number, fn: () => Promise<void> }>} */
const republishJobs = new Map();
let wakeTimer = null;
let draining = false;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function publishMinGapMs() {
    return Number(process.env.PUBLISH_MIN_GAP_MS || 15_000);
}

function publishRateLimitPauseMs() {
    return Number(process.env.PUBLISH_RATE_LIMIT_PAUSE_MS || 900_000);
}

function publishRateLimitMaxRetryMs() {
    return Number(process.env.PUBLISH_RATE_LIMIT_MAX_MS || 900_000);
}

function baseRetryMs() {
    return Number(process.env.PUBLISH_RETRY_MS || 120_000);
}

export function isPublishRateLimitError(err) {
    return /слишком много попыток/i.test(String(err?.message || err || ''));
}

export function notePublishRateLimit(err) {
    if (!isPublishRateLimitError(err)) return;
    rateLimitUntil = Math.max(rateLimitUntil, Date.now() + publishRateLimitPauseMs());
    console.warn(
        `[sell] publish-queue: rate-limit → пауза ${publishRateLimitPauseMs() / 1000}с`,
    );
}

/** Задержка повтора: после rate-limit — общая пауза очереди, иначе базовая. */
export function publishRetryDelayMs(attempt, errMsg) {
    if (isPublishRateLimitError(errMsg)) {
        const remain = Math.max(0, rateLimitUntil - Date.now());
        return Math.max(remain, publishRateLimitPauseMs());
    }
    void attempt;
    return baseRetryMs();
}

export function isRepublishQueued(dealId) {
    return republishJobs.has(dealId);
}

export function republishQueueSize() {
    return republishJobs.size;
}

/**
 * Поставить перевыставление в общую очередь (дедуп по dealId).
 * @param {string} dealId
 * @param {number} delayMs
 * @param {() => Promise<void>} fn
 */
export function queueRepublish(dealId, delayMs, fn) {
    const runAt = Date.now() + Math.max(0, delayMs);
    const prev = republishJobs.get(dealId);
    if (prev) {
        republishJobs.set(dealId, {
            runAt: Math.max(prev.runAt, runAt),
            fn,
        });
    } else {
        republishJobs.set(dealId, { runAt, fn });
    }
    scheduleRepublishWake();
}

function scheduleRepublishWake() {
    if (draining) return;
    if (wakeTimer) clearTimeout(wakeTimer);

    const now = Date.now();
    let nextAt = Infinity;
    for (const job of republishJobs.values()) {
        if (job.runAt < nextAt) nextAt = job.runAt;
    }
    if (nextAt === Infinity) return;

    const wait = Math.max(0, nextAt - now);
    wakeTimer = setTimeout(() => {
        wakeTimer = null;
        void drainRepublishQueue();
    }, wait);
}

async function drainRepublishQueue() {
    if (draining) return;
    draining = true;
    try {
        for (;;) {
            const now = Date.now();
            const rateWait = rateLimitUntil - now;
            if (rateWait > 0) {
                console.log(
                    `[sell] publish-queue: ждём rate-limit ${Math.ceil(rateWait / 1000)}с ` +
                        `(в очереди ${republishJobs.size})`,
                );
                await sleep(rateWait);
            }

            const gapWait = publishMinGapMs() - (Date.now() - lastRunAt);
            if (gapWait > 0) await sleep(gapWait);

            let pickId = null;
            let pickJob = null;
            for (const [dealId, job] of republishJobs) {
                if (job.runAt > Date.now()) continue;
                if (!pickJob || job.runAt < pickJob.runAt) {
                    pickId = dealId;
                    pickJob = job;
                }
            }
            if (!pickId || !pickJob) {
                scheduleRepublishWake();
                break;
            }

            republishJobs.delete(pickId);
            lastRunAt = Date.now();
            try {
                await pickJob.fn();
            } catch (e) {
                notePublishRateLimit(e);
                console.warn(
                    `[sell] publish-queue ${pickId.slice(0, 8)}…: ${e.message || e}`,
                );
            }

            if (!republishJobs.size) break;
        }
    } finally {
        draining = false;
        if (republishJobs.size) scheduleRepublishWake();
    }
}

/** @deprecated — используй queueRepublish; оставлено для совместимости */
export function enqueuePublishWork(fn) {
    queueRepublish(`__legacy_${Date.now()}`, 0, fn);
}
