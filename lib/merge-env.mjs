import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { projectRoot } from './env.mjs';

/** Обновить ключи в sell/.env */
export async function mergeEnvVars(vars) {
    const envPath = join(projectRoot, '.env');
    let content = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';

    for (const [key, value] of Object.entries(vars)) {
        if (value == null || value === '') continue;
        const line = `${key}=${value}`;
        const re = new RegExp(`^${key}=.*$`, 'm');
        if (re.test(content)) {
            content = content.replace(re, line);
        } else {
            content += (content.endsWith('\n') ? '' : '\n') + line + '\n';
        }
    }

    await writeFile(envPath, content);
    return envPath;
}
