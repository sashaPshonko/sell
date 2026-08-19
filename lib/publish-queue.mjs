/** Глобальная очередь publishItem — один запрос за раз, пауза после rate-limit. */

let chain = Promise.resolve();
let rateLimitUntil = 0;
let lastRunAt = 0;

function publishMinGapMs() {
    return Number(process.env.PUBLISH_MIN_GAP_MS || 8_000);
}

function publishRateLimitPauseMs() {
    return Number(process.env.PUBLISH_RATE_LIMIT_PAUSE_MS || 300_000);
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
        `[sell] publish-queue: rate-limit → пауза ${publishRateLimitPauseMs() / 1000}с для всех перевыставлений`,
    );
}

/** Задержка повтора: экспонента на rate-limit, иначе базовая. */
export function publishRetryDelayMs(attempt, errMsg) {
    const base = baseRetryMs();
    if (!isPublishRateLimitError(errMsg)) return base;
    const mult = 2 ** Math.min(Math.max(Number(attempt) - 1, 0), 4);
    return Math.min(base * mult, publishRateLimitMaxRetryMs());
}

export function enqueuePublishWork(fn) {
    const job = async () => {
        const rateWait = rateLimitUntil - Date.now();
        if (rateWait > 0) {
            console.log(
                `[sell] publish-queue: ждём rate-limit ${Math.ceil(rateWait / 1000)}с`,
            );
            await new Promise((r) => setTimeout(r, rateWait));
        }
        const gapWait = publishMinGapMs() - (Date.now() - lastRunAt);
        if (gapWait > 0) {
            await new Promise((r) => setTimeout(r, gapWait));
        }
        lastRunAt = Date.now();
        try {
            return await fn();
        } catch (e) {
            notePublishRateLimit(e);
            throw e;
        }
    };
    const p = chain.then(job, job);
    chain = p.catch(() => {});
    return p;
}
