/**
 * Очередь перевыставления: свежие лоты первыми, зависший не стопорит остальных.
 * Между попытками — короткий gap. Rate-limit — backoff у этого лота + короткая пауза пачки.
 */
let burstPauseUntil = 0;
let consecutiveRateLimits = 0;
let lastRunAt = 0;

/** @type {Map<string, { runAt: number, fn: () => Promise<void>, paidAtMs: number }>} */
const republishJobs = new Map();
let wakeTimer = null;
let draining = false;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function publishMinGapMs() {
    return Number(process.env.PUBLISH_MIN_GAP_MS || 20_000);
}

function burstPauseMs() {
    return Number(process.env.PUBLISH_BURST_PAUSE_MS || 45_000);
}

function rateLimitLotBackoffMs(attempt) {
    const base = Number(process.env.PUBLISH_RATE_LIMIT_LOT_MS || 90_000);
    const cap = Number(process.env.PUBLISH_RATE_LIMIT_MAX_MS || 600_000);
    const exp = Math.min(Math.max(0, Number(attempt) || 0), 4);
    return Math.min(cap, base * 2 ** exp);
}

function baseRetryMs() {
    return Number(process.env.PUBLISH_RETRY_MS || 20_000);
}

export function isPublishRateLimitError(err) {
    return /слишком много попыток/i.test(String(err?.message || err || ''));
}

export function notePublishSuccess() {
    consecutiveRateLimits = 0;
}

export function notePublishRateLimit(err) {
    if (!isPublishRateLimitError(err)) return;
    consecutiveRateLimits += 1;
    if (consecutiveRateLimits >= 2) {
        burstPauseUntil = Math.max(burstPauseUntil, Date.now() + burstPauseMs());
        console.warn(
            `[sell] publish-queue: пачка 429 → пауза ${burstPauseMs() / 1000}с ` +
                `(не держим всю очередь на одном лоте)`,
        );
    }
}

/** Повтор этого лота. Rate-limit не замораживает остальные. */
export function publishRetryDelayMs(attempt, errMsg) {
    if (isPublishRateLimitError(errMsg)) {
        return rateLimitLotBackoffMs(attempt);
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

export function paidAtMsFromOrder(order) {
    const t = Date.parse(order?.paidAt || '');
    return Number.isFinite(t) && t > 0 ? t : 0;
}

/** Среди готовых — самый свежий paidAt, не тот кто дольше стоит в очереди. */
export function pickDueRepublishJob(jobs, now = Date.now()) {
    let pickId = null;
    let pickJob = null;
    for (const [dealId, job] of jobs) {
        if (!job || job.runAt > now) continue;
        const pri = Number(job.paidAtMs || 0);
        const best = Number(pickJob?.paidAtMs || 0);
        if (!pickJob || pri > best || (pri === best && job.runAt < pickJob.runAt)) {
            pickId = dealId;
            pickJob = job;
        }
    }
    return { pickId, pickJob };
}

/**
 * @param {string} dealId
 * @param {number} delayMs
 * @param {() => Promise<void>} fn
 * @param {{ paidAtMs?: number }} [opts]
 */
export function queueRepublish(dealId, delayMs, fn, opts = {}) {
    const prev = republishJobs.get(dealId);
    const paidAtMs = Number(opts.paidAtMs ?? prev?.paidAtMs ?? 0) || 0;
    republishJobs.set(dealId, {
        runAt: Date.now() + Math.max(0, delayMs),
        fn,
        paidAtMs,
    });
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
    if (burstPauseUntil > now) {
        nextAt = Math.max(nextAt === Infinity ? burstPauseUntil : nextAt, burstPauseUntil);
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
            const burstWait = burstPauseUntil - Date.now();
            if (burstWait > 0) {
                console.log(
                    `[sell] publish-queue: короткая пауза ${Math.ceil(burstWait / 1000)}с ` +
                        `(в очереди ${republishJobs.size})`,
                );
                await sleep(burstWait);
            }

            const gapWait = publishMinGapMs() - (Date.now() - lastRunAt);
            if (gapWait > 0) await sleep(gapWait);

            const { pickId, pickJob } = pickDueRepublishJob(republishJobs);
            if (!pickId || !pickJob) {
                scheduleRepublishWake();
                break;
            }

            republishJobs.delete(pickId);
            lastRunAt = Date.now();
            console.log(
                `[sell] publish-queue: берём ${pickId.slice(0, 8)}… ` +
                    `(ещё ${republishJobs.size}, свежесть ${pickJob.paidAtMs || 0})`,
            );
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
