/** Последний известный баланс для TG-алертов (не для poll). */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'last-balance.json');

export function loadLastBalance(username) {
    if (!username || !existsSync(PATH)) return null;
    try {
        const data = JSON.parse(readFileSync(PATH, 'utf8'));
        if (data.username !== username) return null;
        const coins = Number(data.coins);
        return Number.isFinite(coins) && coins >= 0 ? coins : null;
    } catch {
        return null;
    }
}

export function saveLastBalance(username, coins) {
    if (!username) return;
    const n = Number(coins);
    if (!Number.isFinite(n) || n < 0) return;
    writeFileSync(
        PATH,
        JSON.stringify(
            {
                username,
                coins: Math.round(n),
                updatedAt: new Date().toISOString(),
            },
            null,
            2,
        ),
    );
}
