/** Парковка мелкого баланса случайному «Герцог» из tab list через /pay. */

export const PAY_SUCCESS_MARKER = '[✔] Успешно!';
export const DUKE_RANK_MARKER = 'Герцог';

/**
 * Ранг в tab — как у ResCue1337: displayName.text = '⚡ Герцог '
 * (ник обычно в extra / username).
 * @param {object} player — bot.players[nick]
 */
export function playerTabLabel(player) {
    if (!player) return '';
    const dn = player.displayName;
    if (!dn) return String(player.username || '');
    // Сначала .text — там ранг FunTime («⚡ Герцог »)
    if (dn.text) return String(dn.text);
    try {
        if (typeof dn.toString === 'function') return String(dn.toString());
    } catch {
        /* ignore */
    }
    return String(player.username || '');
}

/**
 * Ники с рангом Герцог в tab (кроме себя).
 * Пример: ResCue1337 → displayName.text: '⚡ Герцог '
 * @param {Record<string, object>} players — bot.players
 * @param {string} selfUsername
 */
export function listDukeNicks(players, selfUsername) {
    const self = String(selfUsername || '').toLowerCase();
    const out = [];
    for (const [username, p] of Object.entries(players || {})) {
        if (!username || username.toLowerCase() === self) continue;
        if (p?.listed === 0) continue;
        const label = playerTabLabel(p);
        if (!label.includes(DUKE_RANK_MARKER)) continue;
        out.push(username);
    }
    return out;
}

/** Fisher–Yates */
export function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

export function isPaySuccessLine(text) {
    const plain = String(text || '')
        .replace(/§./g, '')
        .replace(/&[0-9a-fk-or]/gi, '');
    return plain.includes(PAY_SUCCESS_MARKER);
}
