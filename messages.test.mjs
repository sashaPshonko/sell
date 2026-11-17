import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from './messages.mjs';

// Регресс: askNickInChatLine пропал из файла, и приветствие падало с ReferenceError уже после оплаты.
test('тексты покупателю собираются без ошибок', () => {
    const texts = [
        m.buildGreetingText(),
        m.buildNewOrderTwinHint({ lotKk: 200 }),
        m.buildWrongNickHint(),
        m.buildRetryNickHint(),
        m.buildCaptchaWaitHint(),
        m.buildOrderCancelDeniedHint(),
        ...['captcha', 'banned', 'insufficient_funds', 'balance_unread', 'player_offline', 'proxy_timeout', 'bot_offline', 'x'].map((r) => m.buildDeliveryFailHint(r)),
    ];
    for (const t of texts) assert.ok(typeof t === 'string' && t.length > 10);
});

test('в приветствии нет угроз баном и есть маркер приветствия', () => {
    const g = m.buildGreetingText();
    assert.ok(!/твинк|обязательно|возможен\s*бан/i.test(g));
    assert.ok(/без\s*банов/i.test(g));
    assert.ok(g.toLowerCase().includes('заходи на анархию'));
});

test('капча: просим подождать, без «не удалось выдать»', () => {
    const t = m.buildDeliveryFailHint('captcha');
    assert.ok(t.includes('усердно решает капчу'));
    assert.ok(!t.includes('Не удалось выдать'));
});

// Регресс: poll.mjs не стартовал, потому что chat-session.mjs импортировал отсутствующий экспорт из messages.mjs.
test('все импорты из messages.mjs существуют', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const names = new Set(Object.keys(m));
    const bad = [];
    for (const f of readdirSync('.').filter((x) => x.endsWith('.mjs'))) {
        const src = readFileSync(f, 'utf8');
        for (const mm of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/messages\.mjs'/g)) {
            for (const n of mm[1].split(',').map((x) => x.trim().split(' as ')[0]).filter(Boolean)) {
                if (!names.has(n)) bad.push(`${f}: ${n}`);
            }
        }
    }
    assert.deepEqual(bad, []);
});

test('приветствие короткое, якорь в чате находится', async () => {
    const g = m.buildGreetingText();
    assert.ok(!/бедрок|автоматическая/i.test(g));
    const { findGreetingAnchorInChat } = await import('./parse.mjs');
    const at = '2026-11-12T10:00:00.000Z';
    assert.equal(findGreetingAnchorInChat([{ text: g, user: { id: 'S' }, createdAt: at }], 'S'), at);
    // старое приветствие в уже открытых чатах
    assert.equal(
        findGreetingAnchorInChat([{ text: 'ЗАХОДИ\n✅ выдача автоматическая - бот выдаст сам', user: { id: 'S' }, createdAt: at }], 'S'),
        at,
    );
});
