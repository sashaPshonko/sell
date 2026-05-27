import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { applySellDefaults } from './defaults.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** sell/.env — только PLAYEROK_TOKEN; остальное в lib/defaults.mjs */
export function loadEnv() {
    config({ path: join(ROOT, '.env') });
    applySellDefaults();
}

export const projectRoot = ROOT;
