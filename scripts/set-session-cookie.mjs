/**
 * Сохранить cookies для chatMessages (нужен auid).
 *
 *   npm run set-session -- captures/paste.curl
 *   cat paste.curl | npm run set-session
 *   npm run set-session -- "fakeauid=...; auid=...; token=..."
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadEnv, projectRoot } from '../lib/env.mjs';
import { extractCookieHeaderFromCurl, extractTokenFromCurl } from '../lib/curl-parse.mjs';
import { saveTokenToEnv } from '../lib/save-token.mjs';

loadEnv();

const arg = process.argv[2]?.trim();
let raw = '';

if (!arg) {
    raw = await new Promise((resolve) => {
        const chunks = [];
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => chunks.push(c));
        process.stdin.on('end', () => resolve(chunks.join('')));
        if (process.stdin.isTTY) resolve('');
    });
} else if (existsSync(join(projectRoot, arg.replace(/^\.\//, '')))) {
    raw = await readFile(join(projectRoot, arg.replace(/^\.\//, '')), 'utf8');
} else if (existsSync(arg)) {
    raw = await readFile(arg, 'utf8');
} else {
    raw = arg;
}

raw = raw.trim();
if (!raw) {
    console.error(`
Нужны cookies с auid (из Copy as cURL запроса chatMessages):

  1) playerok.com → открой чат → F12 → Network → chatMessages
  2) Copy as cURL → сохрани в captures/paste.curl
  3) npm run set-session -- captures/paste.curl

Или с Mac на VPS:
  scp captures/session.cookie root@IP:~/sell/captures/
`);
    process.exit(1);
}

let cookies = raw.includes('curl ') ? extractCookieHeaderFromCurl(raw) : null;
if (!cookies && /auid=/i.test(raw) && !raw.includes('curl ')) {
    cookies = raw.replace(/^cookie:\s*/i, '').trim();
}
if (!cookies) {
    console.error('[set-session] не нашёл cookies (нужна строка с auid= из -b в cURL)');
    process.exit(1);
}
if (!/(?:^|;\s*)auid=/i.test(cookies)) {
    console.error('[set-session] в cookies нет auid= — скопируй полный -b из cURL chatMessages');
    process.exit(1);
}

const outDir = join(projectRoot, 'captures');
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, 'session.cookie');
await writeFile(outPath, cookies + '\n');
console.log(`[set-session] ok → ${outPath} (${cookies.length} символов)`);

const token = extractTokenFromCurl(raw) || cookies.match(/(?:^|;\s*)token=([^;\s]+)/i)?.[1];
if (token) {
    await saveTokenToEnv(token);
    console.log('[set-session] PLAYEROK_TOKEN обновлён в .env');
}

process.env.PLAYEROK_COOKIES = cookies;
const { createClient } = await import('../playerok-client.mjs');
const c = createClient();
const v = await c.viewer();
const chats = await c.userChats(v.viewer.id, 3);
const edges = chats.userChats?.edges || [];
if (!edges.length) {
    console.log('[set-session] viewer ok, чатов в списке 0 — проверь аккаунт');
    process.exit(0);
}
const chatId = edges[0].node.id;
const m = await c.chatMessages(chatId, 3);
console.log(
    `[set-session] chatMessages ok: ${m.chatMessages?.edges?.length ?? 0} сообщений`,
);
