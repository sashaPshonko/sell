/**
 * Сбор настроек из Copy as cURL (без HAR).
 *
 * 1) Открой чат на playerok.com, в Network найди запрос chatMessages → Copy as cURL
 * 2) Напиши «тест» в чат → найди POST graphql (отправка) → Copy as cURL
 * 3) Вставь ОБА в sell/captures/paste.curl (один под другим)
 * 4) npm run capture-curl
 */
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadEnv, projectRoot } from '../lib/env.mjs';
import { saveTokenToEnv } from '../lib/save-token.mjs';
import {
    extractTokenFromCurl,
    extractPersistedFromCurl,
    extractPostOperationsFromCurl,
    extractCookieHeaderFromCurl,
    splitCurlBlocks,
} from '../lib/curl-parse.mjs';
import { classifyOperations, toEnvVariables } from '../lib/har-parse.mjs';
import { mergeEnvVars } from '../lib/merge-env.mjs';

loadEnv();

const pasteArg = process.argv[2]?.trim();
const pastePath = pasteArg
    ? join(projectRoot, pasteArg.replace(/^\.\//, ''))
    : join(projectRoot, 'captures/paste.curl');

if (!existsSync(pastePath)) {
    const example = join(projectRoot, 'captures/paste.curl.example');
    if (existsSync(example)) {
        const { copyFile } = await import('fs/promises');
        await copyFile(example, pastePath);
    } else {
        await writeFile(
            pastePath,
            '# вставь Copy as cURL (chatMessages) с playerok.com\n',
        );
    }
    console.error(`
Создан файл: ${pasteArg || 'captures/paste.curl'}

cURL снимаешь на СВОЁМ компе в Chrome (на VPS нет playerok):
  1) playerok.com → чат → F12 → Network → chatMessages
  2) Copy as cURL
  3) На сервере: nano captures/paste.curl  → вставь cURL → сохрани
  4) npm run capture-curl

Или с Mac: scp captures/paste.curl root@сервер:~/sell/captures/
`);
    process.exit(1);
}

if ((await readFile(pastePath, 'utf8')).trim().length < 20) {
    console.error(`
Файл ${pasteArg || 'captures/paste.curl'} пустой (только комментарии).

nano captures/paste.curl
→ вставь Copy as cURL (chatMessages) с playerok.com
→ npm run capture-curl
`);
    process.exit(1);
}

let curl = existsSync(pastePath) ? await readFile(pastePath, 'utf8') : '';
curl = curl.replace(/^#.*\n/gm, '').trim();
if (!curl.includes('playerok.com') && !curl.includes('curl ')) {
    console.error(`
Файл captures/paste.curl пустой (только комментарии).

Сделай так:
  1) Cursor: открой sell/captures/paste.curl
  2) Chrome: playerok.com → чат → F12 → Network
  3) Клик по строке graphql (когда открыл чат)
  4) ПКМ → Copy → Copy as cURL
  5) В paste.curl: Cmd+A → Cmd+V (замени ВСЁ содержимое) → Сохрани
  6) npm run capture-curl

Должна начинаться строка с curl 'https://playerok.com/...
`);
    process.exit(1);
}

const lines = [];
const token = extractTokenFromCurl(curl);
if (token && (!process.env.PLAYEROK_TOKEN || process.env.PLAYEROK_TOKEN === 'paste_jwt_here')) {
    await saveTokenToEnv(token);
    console.log('[capture-curl] токен → .env');
}

const cookieHdr = extractCookieHeaderFromCurl(curl);
if (cookieHdr) {
    lines.push(`PLAYEROK_COOKIES=${cookieHdr}`);
    console.log('[capture-curl] cookies → .env (PLAYEROK_COOKIES)');
}

const blocks = splitCurlBlocks(curl);
const allCurl = blocks.length ? blocks.join('\n\n') : curl;

const hashes = extractPersistedFromCurl(allCurl);
if (hashes.userChats) lines.push(`USER_CHATS_HASH=${hashes.userChats}`);
if (hashes.chatMessages) lines.push(`CHAT_MESSAGES_HASH=${hashes.chatMessages}`);
if (hashes.chatMessages) console.log('[capture-curl] CHAT_MESSAGES_HASH ok');

const postOps = blocks.flatMap((b) => extractPostOperationsFromCurl(b));
const classified = classifyOperations(
    postOps.map((o) => ({ ...o, method: 'POST', hash: null, score: 10 })),
);

if (classified.send?.query) {
    await writeFile(join(projectRoot, 'captures/send-message.graphql'), classified.send.query.trim() + '\n');
    const opName = classified.send.gqlOp || classified.send.operationName;
    lines.push(`SEND_MESSAGE_OPERATION=${opName}`);
    lines.push('SEND_MESSAGE_MUTATION_FILE=./captures/send-message.graphql');
    lines.push(`SEND_MESSAGE_VARIABLES=${toEnvVariables(classified.send.variables)}`);
    console.log(`[capture-curl] отправка сообщений → ${opName}`);
}

const updateDeal = postOps.find((o) => o.operationName === 'updateDeal');
if (updateDeal) {
    const st = updateDeal.variables?.input?.status || 'CONFIRMED';
    const dealVars = JSON.stringify(updateDeal.variables).replaceAll(
        updateDeal.variables?.input?.id || '',
        'DEAL_ID',
    );

    if (st === 'CANCELLED' || st === 'ROLLED_BACK' || st === 'CANCELED') {
        const slimQuery = `mutation updateDeal($input: UpdateItemDealInput!) {
  updateDeal(input: $input) {
    id
    status
    direction
    __typename
  }
}
`;
        await writeFile(join(projectRoot, 'captures/cancel-deal.graphql'), slimQuery);
        const cancelVars = JSON.stringify({
            input: { id: 'DEAL_ID', status: st },
        });
        lines.push('AUTO_CANCEL_PLAYEROK=1');
        lines.push('CANCEL_DEAL_OPERATION=updateDeal');
        lines.push('CANCEL_DEAL_MUTATION_FILE=./captures/cancel-deal.graphql');
        lines.push(`CANCEL_DEAL_STATUS=${st}`);
        lines.push(`CANCEL_DEAL_VARIABLES=${cancelVars}`);
        console.log(`[capture-curl] updateDeal ${st} → отмена на PlayerOK`);
    } else if (st === 'SENT') {
        lines.push('CONFIRM_DEAL_OPERATION=updateDeal');
        lines.push('CONFIRM_DEAL_MUTATION_FILE=./captures/update-deal.graphql');
        lines.push('MARK_SENT_OPERATION=updateDeal');
        lines.push('MARK_SENT_MUTATION_FILE=./captures/update-deal.graphql');
        console.log('[capture-curl] updateDeal SENT = «отправил» (не «выполнил»)');
        console.log('[capture-curl] для «Выполнил» сними cURL с status CONFIRMED');
    } else {
        lines.push('CONFIRM_DEAL_OPERATION=updateDeal');
        lines.push('CONFIRM_DEAL_MUTATION_FILE=./captures/update-deal.graphql');
        lines.push(`CONFIRM_DEAL_STATUS=${st}`);
        lines.push(`CONFIRM_DEAL_VARIABLES=${dealVars}`);
        console.log(`[capture-curl] updateDeal ${st} → подтверждение`);
    }
}
if (classified.confirm?.query && !updateDeal) {
    await writeFile(join(projectRoot, 'captures/confirm-deal.graphql'), classified.confirm.query.trim() + '\n');
    const opName = classified.confirm.gqlOp || classified.confirm.operationName;
    lines.push(`CONFIRM_DEAL_OPERATION=${opName}`);
    lines.push('CONFIRM_DEAL_MUTATION_FILE=./captures/confirm-deal.graphql');
    console.log(`[capture-curl] «Выполнил» → ${opName}`);
}

const postNames = postOps.map((o) => o.operationName).join(', ');
if (postNames === 'viewer' || curl.includes('x-gql-op: viewer')) {
    console.warn(`
Сейчас в paste.curl запрос viewer — он уже работает, но для автопродажи нужен другой:

  1) Network → в поиске (Filter) напиши: chatMessages
  2) Открой чат слева — появится строка graphql с chatMessages
  3) ПКМ → Copy → Copy as cURL → замени содержимое paste.curl
  4) npm run capture-curl

Потом напиши «тест» в чат → Copy as cURL POST (не viewer) → допиши в конец paste.curl
`);
} else if (!hashes.chatMessages) {
    console.warn('[capture-curl] нет chatMessages — фильтр Network: chatMessages');
}
if (!classified.send) {
    console.warn('[capture-curl] нет отправки сообщения — напиши «тест» в чат, Copy as cURL POST');
}

const envVars = {};
for (const line of lines) {
    if (line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) envVars[line.slice(0, i)] = line.slice(i + 1);
}
if (cookieHdr) envVars.PLAYEROK_COOKIES = cookieHdr;
if (Object.keys(envVars).length) {
    const p = await mergeEnvVars(envVars);
    console.log(`\n[capture-curl] записано в ${p}`);
}
if (lines.length) {
    const snippet = '# capture-curl\n' + lines.join('\n') + '\n';
    await writeFile(join(projectRoot, 'captures/env.generated'), snippet);
}

console.log('\nПроверка API: npm run capture');
