import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Всегда грузим sell/.env, даже если команда запущена из другой папки */
export function loadEnv() {
    config({ path: join(ROOT, '.env') });
}

export const projectRoot = ROOT;
