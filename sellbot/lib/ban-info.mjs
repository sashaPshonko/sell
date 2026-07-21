/** Парсинг экрана бана FunTime из чата (несколько строк). */

/**
 * @typedef {{
 *   permanent: boolean,
 *   days?: number,
 *   hours?: number,
 *   minutes?: number,
 *   issuedAt?: string,
 *   reason?: string,
 * }} BanInfo
 */

/** @param {string} text */
export function parseBanFromChat(text) {
    if (!text) return null;
    const t = String(text);
    if (!/забанен/i.test(t)) return null;

    /** @type {BanInfo} */
    const ban = { permanent: false };

    const issued = t.match(/бан выдан:\s*([^\n]+)/i);
    if (issued) ban.issuedAt = issued[1].trim();

    const reason = t.match(/по причине:\s*([^\n]+)/i);
    if (reason) ban.reason = reason[1].trim();

    if (/навсегда/i.test(t)) {
        ban.permanent = true;
        return ban;
    }

    const unban = t.match(/разбан через:\s*([^\n]+)/i);
    if (unban) {
        const chunk = unban[1];
        const days = chunk.match(/(\d+)\s*д/i);
        const hours = chunk.match(/(\d+)\s*ч/i);
        const minutes = chunk.match(/(\d+)\s*м/i);
        ban.days = days ? parseInt(days[1], 10) : 0;
        ban.hours = hours ? parseInt(hours[1], 10) : 0;
        ban.minutes = minutes ? parseInt(minutes[1], 10) : 0;
        ban.permanent = false;
        return ban;
    }

    ban.permanent = true;
    return ban;
}

/** @param {BanInfo | null | undefined} ban */
export function formatBanDuration(ban) {
    if (!ban) return 'неизвестно';
    if (ban.permanent) return 'навсегда';
    const parts = [];
    if (ban.days) parts.push(`${ban.days} д`);
    if (ban.hours) parts.push(`${ban.hours} ч`);
    if (ban.minutes != null) parts.push(`${ban.minutes} м`);
    return parts.length ? parts.join(', ') : 'неизвестно';
}

/**
 * @param {string} username
 * @param {{ ban?: BanInfo | null, balance?: number | null }} [opts]
 */
export function buildBanTelegramAlert(username, { ban, balance } = {}) {
    const lines = [`🚫 ${username} забанен на FunTime`];
    if (ban) {
        lines.push(`Срок: ${formatBanDuration(ban)}`);
        if (ban.reason) lines.push(`Причина: ${ban.reason}`);
        if (ban.issuedAt) lines.push(`Бан с: ${ban.issuedAt}`);
    }
    if (
        ban &&
        !ban.permanent &&
        balance != null &&
        Number.isFinite(balance) &&
        balance > 0
    ) {
        lines.push(`Баланс при последнем чтении: ${balance.toLocaleString('ru-RU')}`);
    }
    return lines.join('\n');
}
