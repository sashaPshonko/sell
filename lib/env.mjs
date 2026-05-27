import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { applySellDefaults } from './defaults.mjs';
import { loadSessionAuth } from './session-auth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** .env — PLAYEROK_TOKEN; cookies → captures/session.cookie; остальное — defaults */
export function loadEnv() {
    config({ path: join(ROOT, '.env') });
    loadSessionAuth(ROOT);
    applySellDefaults();
}

export const projectRoot = ROOT;
