import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    pickDueRepublishJob,
    publishRetryDelayMs,
    isPublishRateLimitError,
} from './publish-queue.mjs';

test('из готовых берём свежий лот, не того кто дольше ждёт', () => {
    const now = 1_000_000;
    const jobs = new Map([
        ['old', { runAt: now - 1000, paidAtMs: 100, fn: () => {} }],
        ['new', { runAt: now - 10, paidAtMs: 500, fn: () => {} }],
        ['later', { runAt: now + 5000, paidAtMs: 900, fn: () => {} }],
    ]);
    const { pickId } = pickDueRepublishJob(jobs, now);
    assert.equal(pickId, 'new');
});

test('rate-limit не ставит 15 минут на всю очередь', () => {
    const msg = 'PlayerOK GraphQL: Слишком много попыток, пожалуйста, попробуйте повторить запрос позже';
    assert.equal(isPublishRateLimitError(msg), true);
    const delay = publishRetryDelayMs(0, msg);
    assert.ok(delay <= 90_000, delay);
    assert.ok(delay < 900_000);
});
