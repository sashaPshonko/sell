/** «Участники: [Лидер]nick, [Участник]nick2, …» из /clan info */
export const CLAN_MEMBERS_MARKER = 'Участники:';

const MEMBER_NAME_RE = /\][\s]*([a-zA-Z0-9_]{3,16})/g;

/**
 * @param {string} text
 * @returns {string[] | null} lowercase nicks
 */
export function parseClanMembersFromChat(text) {
    if (!text?.includes(CLAN_MEMBERS_MARKER)) return null;
    const idx = text.indexOf(CLAN_MEMBERS_MARKER);
    const tail = text.slice(idx + CLAN_MEMBERS_MARKER.length);
    const names = [];
    let m;
    MEMBER_NAME_RE.lastIndex = 0;
    while ((m = MEMBER_NAME_RE.exec(tail)) !== null) {
        names.push(m[1].toLowerCase());
    }
    return names.length ? names : null;
}

/** @param {string[]} allowedLower — lowercase */
export function findClanIntruders(members, allowedLower) {
    const allowed = new Set(allowedLower.map((n) => String(n).toLowerCase()));
    return members.filter((m) => !allowed.has(m));
}
