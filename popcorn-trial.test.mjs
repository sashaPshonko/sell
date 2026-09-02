import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPopcornTrialHint,
    popcornTrialUrl,
    DEFAULT_POPCORN_TRIAL_URL,
} from './messages.mjs';
import { isSubscriptionLot, parseSubscriptionDays } from './parse.mjs';

test('пробник 3 дня — ссылка и текст без олух', () => {
    const t = buildPopcornTrialHint();
    assert.match(t, /фармить как я/i);
    assert.match(t, /ботов/);
    assert.equal(/олух/i.test(t), false);
    assert.ok(t.includes(DEFAULT_POPCORN_TRIAL_URL));
});

test('лот 3 дня парсится как подписка на 3д', () => {
    const name = 'ФАРМ-БОТ 🤖 FUNTIME 🤖 3 ДНЯ';
    assert.equal(isSubscriptionLot(name), true);
    assert.equal(parseSubscriptionDays(name), 3);
});

test('POPCORN_TRIAL_URL=0 выключает апселл', () => {
    const prev = process.env.POPCORN_TRIAL_URL;
    process.env.POPCORN_TRIAL_URL = '0';
    try {
        assert.equal(popcornTrialUrl(), '');
        assert.equal(buildPopcornTrialHint(), '');
    } finally {
        if (prev == null) delete process.env.POPCORN_TRIAL_URL;
        else process.env.POPCORN_TRIAL_URL = prev;
    }
});
