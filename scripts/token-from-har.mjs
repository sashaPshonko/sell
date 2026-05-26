/**
 * Только вытащить token из HAR в .env
 * npm run token-from-har -- ~/Downloads/playerok.com.har
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { extractTokenFromHar } from '../lib/har-parse.mjs';
import { saveTokenToEnv } from '../lib/save-token.mjs';

const harPath = process.argv[2];
if (!harPath || !existsSync(harPath)) {
    console.error('Укажи путь к HAR: npm run token-from-har -- ~/Downloads/playerok.com.har');
    process.exit(1);
}

const har = JSON.parse(await readFile(harPath, 'utf8'));
const token = extractTokenFromHar(har);
if (!token) {
    console.error('В HAR нет cookie token. Сохрани HAR на playerok.com будучи залогиненным (F5 на сайте).');
    process.exit(1);
}

const p = await saveTokenToEnv(token);
console.log(`OK: ${p} (${token.length} символов)`);
