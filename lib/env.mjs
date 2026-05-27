import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { applySellDefaults } from './defaults.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
    config({ path: join(ROOT, '.env') });

    // Битая строка PLAYEROK_COOKIES=token (8 символов) ломала chatMessages
    const cookies = process.env.PLAYEROK_COOKIES?.trim();
    if (
        cookies &&
        (cookies.length < 30 ||
            (!/(?:^|;\s*)auid=/i.test(cookies) && process.env.PLAYEROK_AUID?.trim()))
    ) {
        delete process.env.PLAYEROK_COOKIES;
    }

    applySellDefaults();
}

export const projectRoot = ROOT;
