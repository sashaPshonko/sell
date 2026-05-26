/**
 * Вставить PLAYEROK_TOKEN в .env без ручного редактирования.
 * npm run set-token
 * или: npm run set-token -- "eyJhbG..."
 */
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = join(ROOT, '.env');
const EXAMPLE = join(ROOT, '.env.example');

async function readStdinToken() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('Вставь JWT из cookie token (Enter, потом Ctrl+D или второй Enter на пустой строке):');
    const lines = [];
    for await (const line of rl) {
        if (!line.trim() && lines.length) break;
        if (line.trim()) lines.push(line.trim());
    }
    return lines.join('').replace(/^token=/i, '').trim();
}

async function main() {
    let token = process.argv[2]?.trim();
    if (!token) token = await readStdinToken();

    if (!token || token.length < 50) {
        console.error('Похоже на не тот текст. Нужен длинный JWT из cookie «token» на playerok.com');
        process.exit(1);
    }

    let content;
    if (existsSync(ENV)) {
        content = await readFile(ENV, 'utf8');
    } else if (existsSync(EXAMPLE)) {
        content = await readFile(EXAMPLE, 'utf8');
    } else {
        content = 'PLAYEROK_TOKEN=\nUSER_CHATS_HASH=\n';
    }

    if (/^PLAYEROK_TOKEN=/m.test(content)) {
        content = content.replace(/^PLAYEROK_TOKEN=.*$/m, `PLAYEROK_TOKEN=${token}`);
    } else {
        content = `PLAYEROK_TOKEN=${token}\n` + content;
    }

    await writeFile(ENV, content);
    console.log(`OK → ${ENV} (${token.length} символов)`);
    console.log('Дальше: npm run capture');
}

main();
