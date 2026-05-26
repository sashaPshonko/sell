import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { projectRoot } from './env.mjs';

export async function saveTokenToEnv(token) {
    const envPath = join(projectRoot, '.env');
    const examplePath = join(projectRoot, '.env.example');

    let content;
    if (existsSync(envPath)) {
        content = await readFile(envPath, 'utf8');
    } else if (existsSync(examplePath)) {
        content = await readFile(examplePath, 'utf8');
    } else {
        content = 'PLAYEROK_TOKEN=\nUSER_CHATS_HASH=999f86b7c94a4cb525ed5549d8f24d0d24036214f02a213e8fd7cefc742bbd58\n';
    }

    if (/^PLAYEROK_TOKEN=/m.test(content)) {
        content = content.replace(/^PLAYEROK_TOKEN=.*$/m, `PLAYEROK_TOKEN=${token}`);
    } else {
        content = `PLAYEROK_TOKEN=${token}\n` + content;
    }

    await writeFile(envPath, content);
    return envPath;
}
