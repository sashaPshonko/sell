/**
 * POST на твой простой HTTP-сервер (потом он запустит скрипт бота).
 * Поля: nick, anarchy, amount (kk).
 */
export async function notifyDispatch({ nick, anarchy, amount, dealId, chatId, buyer, server }) {
    const url = process.env.BOT_DISPATCH_URL || process.env.BOT_NOTIFY_URL;
    const payload = {
        nick,
        anarchy: String(anarchy),
        amount,
        dealId,
        chatId,
        buyer,
        server,
    };

    if (!url) {
        console.warn('[sell] BOT_DISPATCH_URL не задан — только лог');
        console.log('[sell] выдача:', JSON.stringify(payload, null, 2));
        return { ok: true, skipped: true };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Сервер выдачи: ${res.status} ${text.slice(0, 300)}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        return { ok: true, raw: text };
    }
}
