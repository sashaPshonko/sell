import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'dotenv';

const SKIP_FROM_SIDE_FILES = new Set(['PLAYEROK_TOKEN']);

/** Подмешать ключи из файла, не перетирая уже заданные в process.env */
function mergeEnvFile(path) {
    if (!existsSync(path)) return;
    const parsed = parse(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
        if (SKIP_FROM_SIDE_FILES.has(key)) continue;
        if (value == null || value === '') continue;
        if (process.env[key] === undefined || process.env[key] === '') {
            process.env[key] = value;
        }
    }
}

function cookiesOkForChatMessages(raw) {
    const s = String(raw || '').trim();
    return s.length > 0 && /(?:^|;\s*)auid=/i.test(s);
}

/** chatMessages на PlayerOK требует auid — одного token= в cookie недостаточно */
export function loadSessionAuth(root) {
    if (!cookiesOkForChatMessages(process.env.PLAYEROK_COOKIES)) {
        delete process.env.PLAYEROK_COOKIES;
    }

    const cookiePath = join(root, 'captures/session.cookie');
    if (!cookiesOkForChatMessages(process.env.PLAYEROK_COOKIES) && existsSync(cookiePath)) {
        const raw = readFileSync(cookiePath, 'utf8').trim();
        if (cookiesOkForChatMessages(raw)) process.env.PLAYEROK_COOKIES = raw;
    }

    mergeEnvFile(join(root, 'captures/env.generated'));

    if (!cookiesOkForChatMessages(process.env.PLAYEROK_COOKIES)) {
        delete process.env.PLAYEROK_COOKIES;
    }
}

export function sessionAuthHint() {
    return (
        'Нужны cookies PlayerOK (auid): DevTools → чат → chatMessages → Copy as cURL → ' +
        'npm run capture-curl (сохранит captures/session.cookie). Либо PLAYEROK_COOKIES=… в .env'
    );
}
