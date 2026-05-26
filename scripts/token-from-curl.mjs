/**
 * Токен из «Copy → Copy as cURL» (любой запрос playerok.com с cookie).
 *
 * 1) Network → ПКМ по graphql → Copy → Copy as cURL
 * 2) Вставь в файл: sell/captures/paste.curl  (или передай путь)
 * 3) npm run token-from-curl
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { projectRoot } from '../lib/env.mjs';
import { saveTokenToEnv } from '../lib/save-token.mjs';

const path = process.argv[2] || join(projectRoot, 'captures/paste.curl');

if (!existsSync(path)) {
    console.error(`
Нет файла ${path}

1) Chrome → Network → ПКМ по запросу graphql (статус 200)
2) Copy → Copy as cURL
3) Создай файл sell/captures/paste.curl и вставь туда (Cmd+V)
4) npm run token-from-curl
`);
    process.exit(1);
}

const curl = await readFile(path, 'utf8');
const m =
    curl.match(/(?:^|[\s'"])token=([^;'"\s\\]+)/i) ||
    curl.match(/cookie:\s*[^'"]*token=([^;'"\s]+)/i);

if (!m?.[1] || m[1].length < 50) {
    console.error('В cURL нет cookie token. Копируй cURL с playerok.com будучи залогиненным.');
    process.exit(1);
}

const envPath = await saveTokenToEnv(m[1]);
console.log(`OK → ${envPath} (${m[1].length} символов)`);
console.log('Дальше: npm run capture');
