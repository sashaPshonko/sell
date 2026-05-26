import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_JSON = join(__dirname, 'bot.json');

/** Настройки sellbot — только bot.json + эти дефолты (без .env) */
export const DEFAULTS = {
    wsPort: 8790,
    payTemplate: '/pay {nick} {amount}',
    paySuffix: 'kk',
    payAmountMultiplier: 0,
    mockDelivery: false,
    mockDeliveryMs: 300,
    healthCheckEnabled: true,
    healthCheckMs: 3_600_000,
    healthCheckFirstMs: 120_000,
    healthCheckObserveMs: 8000,
    idleQuitMs: 25_000,
    deliverTimeoutMs: 60_000,
    payLoopWaitMs: 2000,
    balanceMin: 1_000_000_000,
    balanceWaitMs: 15_000,
    balanceCmdWaitMs: 2000,
    offlineMarkers: ['не в сети', 'оффлайн', 'не онлайн'],
    invalidNickMarkers: ['не найден', 'ник не найден', 'игрок не найден'],
    failMarkers: ['недостаточно', 'ошибка', 'отказано'],
};

function parseMarkers(value, fallback) {
    if (Array.isArray(value)) {
        return value.map((s) => String(s).trim()).filter(Boolean);
    }
    const raw = value ?? fallback;
    if (Array.isArray(raw)) return raw;
    return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function pick(entry, key, def) {
    return entry[key] !== undefined && entry[key] !== null ? entry[key] : def;
}

/**
 * @returns {{ bot: { username, password, anarchy }, settings: typeof DEFAULTS }}
 */
export async function loadSettings(path = BOT_JSON) {
    if (!existsSync(path)) {
        throw new Error(`нет ${path}`);
    }
    const arr = JSON.parse(await readFile(path, 'utf-8'));
    if (!Array.isArray(arr) || !arr[0]?.username) {
        throw new Error(`${path}: массив [{ username, password, anarchy, ... }]`);
    }
    const entry = arr[0];

    const bot = {
        username: entry.username,
        password: entry.password,
        anarchy: Number(entry.anarchy) || 502,
    };

    const settings = {
        wsPort: Number(pick(entry, 'wsPort', DEFAULTS.wsPort)),
        payTemplate: pick(entry, 'payTemplate', DEFAULTS.payTemplate),
        paySuffix: pick(entry, 'paySuffix', DEFAULTS.paySuffix),
        payAmountMultiplier: Number(
            pick(entry, 'payAmountMultiplier', DEFAULTS.payAmountMultiplier),
        ),
        mockDelivery: Boolean(pick(entry, 'mockDelivery', DEFAULTS.mockDelivery)),
        mockDeliveryMs: Number(pick(entry, 'mockDeliveryMs', DEFAULTS.mockDeliveryMs)),
        healthCheckEnabled: pick(entry, 'healthCheckEnabled', DEFAULTS.healthCheckEnabled) !== false,
        healthCheckMs: Number(pick(entry, 'healthCheckMs', DEFAULTS.healthCheckMs)),
        healthCheckFirstMs: Number(pick(entry, 'healthCheckFirstMs', DEFAULTS.healthCheckFirstMs)),
        healthCheckObserveMs: Number(
            pick(entry, 'healthCheckObserveMs', DEFAULTS.healthCheckObserveMs),
        ),
        idleQuitMs: Number(pick(entry, 'idleQuitMs', DEFAULTS.idleQuitMs)),
        deliverTimeoutMs: Number(pick(entry, 'deliverTimeoutMs', DEFAULTS.deliverTimeoutMs)),
        payLoopWaitMs: Number(pick(entry, 'payLoopWaitMs', DEFAULTS.payLoopWaitMs)),
        balanceMin: Number(pick(entry, 'balanceMin', DEFAULTS.balanceMin)),
        balanceWaitMs: Number(pick(entry, 'balanceWaitMs', DEFAULTS.balanceWaitMs)),
        balanceCmdWaitMs: Number(pick(entry, 'balanceCmdWaitMs', DEFAULTS.balanceCmdWaitMs)),
        offlineMarkers: parseMarkers(entry.offlineMarkers, DEFAULTS.offlineMarkers),
        invalidNickMarkers: parseMarkers(entry.invalidNickMarkers, DEFAULTS.invalidNickMarkers),
        failMarkers: parseMarkers(entry.failMarkers, DEFAULTS.failMarkers),
    };

    return { bot, settings };
}
