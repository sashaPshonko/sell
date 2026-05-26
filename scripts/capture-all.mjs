/**
 * Собирает всё нужное для автопродажи:
 * 1) По токену — viewer, чаты, сообщения (captures/snapshots/)
 * 2) Из HAR — mutation отправки сообщения, «Выполнил», hashes (captures/operations/)
 *
 * HAR: открой playerok.com, сделай 3 действия (см. ниже), сохрани HAR, запусти:
 *   npm run capture -- ~/Downloads/playerok.com.har
 */
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadEnv, projectRoot as ROOT } from '../lib/env.mjs';
import { runApiSnapshot } from '../lib/api-snapshot.mjs';
import { parseHarFile, classifyOperations, toEnvVariables, extractTokenFromHar } from '../lib/har-parse.mjs';
import { saveTokenToEnv } from '../lib/save-token.mjs';

loadEnv();

const harPath = process.argv[2] || process.env.HAR_FILE || './captures/playerok.har';

async function findHarOnDisk(explicit) {
    if (explicit && existsSync(explicit)) return explicit;

    const dirs = [
        join(ROOT, 'captures'),
        join(homedir(), 'Downloads'),
        join(homedir(), 'Desktop'),
    ];
    const found = [];
    for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        for (const name of await readdir(dir)) {
            if (!name.toLowerCase().endsWith('.har')) continue;
            found.push(join(dir, name));
        }
    }
    found.sort((a, b) => (existsSync(b) ? 1 : 0));
    return found.find((p) => p.toLowerCase().includes('playerok')) || found[0] || null;
}

async function ensureTokenFromHar(path) {
    if (!existsSync(path)) {
        console.warn(`[capture] HAR не найден: ${path}`);
        return false;
    }
    const har = JSON.parse(await readFile(path, 'utf8'));
    const token = extractTokenFromHar(har);
    if (!token) {
        console.warn(`[capture] в HAR нет cookie token — сохрани HAR на playerok.com (F5 на сайте, залогинен)`);
        return false;
    }
    const envPath = await saveTokenToEnv(token);
    process.env.PLAYEROK_TOKEN = token;
    console.log(`[capture] токен взяли из HAR → ${envPath}`);
    return true;
}
const OPS_DIR = './captures/operations';

async function writeOperations(operations) {
    await mkdir(OPS_DIR, { recursive: true });
    for (const op of operations) {
        const base = join(OPS_DIR, op.operationName);
        if (op.query) {
            await writeFile(`${base}.graphql`, op.query.trim() + '\n');
        }
        await writeFile(
            `${base}.meta.json`,
            JSON.stringify(
                {
                    operationName: op.operationName,
                    gqlOp: op.gqlOp,
                    method: op.method,
                    hash: op.hash,
                    variables: op.variables,
                },
                null,
                2,
            ),
        );
    }
}

async function applyCaptures(classified) {
    const lines = ['# Сгенерировано: npm run capture', `# ${new Date().toISOString()}`, ''];

    if (classified.hashes.userChats) {
        lines.push(`USER_CHATS_HASH=${classified.hashes.userChats}`);
    }
    if (classified.hashes.chatMessages) {
        lines.push(`CHAT_MESSAGES_HASH=${classified.hashes.chatMessages}`);
    }

    if (classified.send?.query) {
        await writeFile('./captures/send-message.graphql', classified.send.query.trim() + '\n');
        const opName = classified.send.gqlOp || classified.send.operationName;
        lines.push(`SEND_MESSAGE_OPERATION=${opName}`);
        lines.push(`SEND_MESSAGE_MUTATION_FILE=./captures/send-message.graphql`);
        lines.push(`SEND_MESSAGE_VARIABLES=${toEnvVariables(classified.send.variables)}`);
        console.log(`[capture] отправка сообщения → ${opName}`);
    }

    if (classified.confirm?.query) {
        await writeFile('./captures/confirm-deal.graphql', classified.confirm.query.trim() + '\n');
        const opName = classified.confirm.gqlOp || classified.confirm.operationName;
        lines.push(`CONFIRM_DEAL_OPERATION=${opName}`);
        lines.push(`CONFIRM_DEAL_MUTATION_FILE=./captures/confirm-deal.graphql`);
        lines.push(`CONFIRM_DEAL_VARIABLES=${toEnvVariables(classified.confirm.variables)}`);
        console.log(`[capture] «Выполнил» → ${opName}`);
    }

    const snippet = lines.join('\n') + '\n';
    await writeFile('./captures/env.generated', snippet);
    return snippet;
}

function printHarInstructions() {
    console.log(`
═══ Нужен HAR (один раз) ═══

1. Chrome → playerok.com (залогинен)
2. F12 → Network → галочка "Preserve log"
3. Сделай по очереди:
   • открой список чатов (если ещё не открыт)
   • открой чат с покупкой
   • напиши в чат любое сообщение (например: тест)
   • (опционально) нажми «Выполнил» на заказе
4. Правый клик по списку запросов → "Save all as HAR with content"
5. Запусти:

   npm run capture -- путь/к/playerok.har

   или положи файл как: sell/captures/playerok.har и снова npm run capture

⚠️  В HAR есть cookie token — не коммить HAR в git.
`);
}

async function main() {
    console.log('[capture] PlayerOK — сбор настроек\n');

    let token = process.env.PLAYEROK_TOKEN?.trim();
    if (!token || token === 'paste_jwt_here') {
        let har = process.argv[2];
        if (har) har = har.replace(/^~/, homedir());
        if (!har || !existsSync(har)) {
            har = await findHarOnDisk(har);
            if (har) console.log(`[capture] нашли HAR: ${har}`);
        }
        if (har) await ensureTokenFromHar(har);
        token = process.env.PLAYEROK_TOKEN?.trim();
    }

    if (!token || token === 'paste_jwt_here') {
        const argvHar = process.argv[2];
        const missingFile = argvHar && !existsSync(argvHar.replace(/^~/, homedir()));
        console.error(missingFile
            ? `
Файл HAR не найден: ${argvHar}

Ты указал путь, но такого файла нет. Сначала сохрани HAR в Chrome:

1) playerok.com (залогинен) → F12 → Network
2) F5 (обновить страницу)
3) ПКМ по списку запросов → «Save all as HAR with content»
4) Проверь в Finder → Загрузки — файл .har появился
5) Запуск (подставь своё имя файла):

   npm run capture -- ~/Downloads/ИМЯ_ФАЙЛА.har
`
            : `
Нет токена. Нужен файл HAR с playerok.com (скрипт сам запишет .env).

1) Chrome → playerok.com → F12 → Network → F5
2) ПКМ → Save all as HAR with content → Загрузки
3) npm run capture -- ~/Downloads/твой_файл.har

Или открой sell/.env и вставь PLAYEROK_TOKEN=... из F12 → Application → Cookies → token
`);
        process.exit(1);
    }

    console.log('[capture] 1/2 API по токену…');
    try {
        const report = await runApiSnapshot();
        console.log(`  viewer: ${report.steps[0]?.username}`);
        console.log(`  чатов: ${report.chatsCount ?? '?'}`);
        if (report.sampleChatId) console.log(`  пример чата: ${report.sampleChatId}`);
        if (report.steps.find((s) => s.step === 'chatMessages' && !s.ok)) {
            console.log(`  chatMessages: ${report.hint || report.steps.at(-1)?.error}`);
        } else {
            console.log('  snapshots → captures/snapshots/');
        }
    } catch (e) {
        console.error('  API ошибка:', e.message);
    }

    console.log('\n[capture] 2/2 HAR (опционально)…');
    if (!existsSync(harPath)) {
        console.log(`
HAR не найден (${harPath}) — это нормально.

Проще без HAR:
  1) Copy as cURL → sell/captures/paste.curl
  2) npm run capture-curl
  3) скопируй строки в .env → npm run capture

`);
        process.exit(0);
    }

    const harRaw = await readFile(harPath, 'utf8');
    const har = JSON.parse(harRaw);
    const operations = parseHarFile(har);
    console.log(`  операций в HAR: ${operations.length}`);
    await writeOperations(operations);

    const classified = classifyOperations(operations);
    const snippet = await applyCaptures(classified);

    console.log('\n[capture] Операции в captures/operations/');
    for (const op of operations) {
        const tags = [];
        if (classified.send?.operationName === op.operationName) tags.push('← SEND');
        if (classified.confirm?.operationName === op.operationName) tags.push('← CONFIRM');
        if (op.hash) tags.push(`hash ${op.hash.slice(0, 12)}…`);
        console.log(`  • ${op.operationName} (${op.method}) ${tags.join(' ')}`);
    }

    console.log('\n─── Скопируй в .env (или merge) ───\n');
    console.log(snippet);

    if (!classified.send) {
        console.log('⚠️  Mutation отправки сообщения не найдена — в HAR нет POST с mutation после того как ты написал «тест» в чат.');
    }

    console.log('\nГотово. Дальше: npm start');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
