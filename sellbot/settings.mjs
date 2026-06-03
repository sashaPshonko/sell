import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DELIVERY_ANARCHY_NUM } from '../config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_JSON = join(__dirname, 'bot.json');

/** Настройки sellbot — только bot.json + эти дефолты (без .env) */
export const DEFAULTS = {
    wsPort: 8790,
    payTemplate: '/pay {nick} {amount}',
    /** Пусто + multiplier: 200кк → 200000000 в /pay */
    paySuffix: '',
    payAmountMultiplier: 1_000_000,
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
    /** Единственная строка: покупатель не на анархии / не в сети на сервере */
    playerOfflineMarker: '[✘] Ошибка! Указанный игрок не найден!',
    /** Не хватает монет на балансе бота для /pay */
    insufficientFundsMarker: '[✘] Ошибка! У вас недостаточно денег.',
    invalidNickMarkers: ['ник не найден'],
    telegramToken: '',
    telegramChatId: '',
    telegramSkip: false,
    /** `off` — напрямую; иначе `socks5h://127.0.0.1:1080` и т.п. */
    telegramProxy: 'off',
    telegramAutoXray: false,
    telegramXrayCmd: '',
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
        /** Анархия — только из sell/config.mjs (поле anarchy в bot.json не используется) */
        anarchy: DELIVERY_ANARCHY_NUM,
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
        playerOfflineMarker: String(
            pick(entry, 'playerOfflineMarker', DEFAULTS.playerOfflineMarker),
        ).trim(),
        insufficientFundsMarker: String(
            pick(entry, 'insufficientFundsMarker', DEFAULTS.insufficientFundsMarker),
        ).trim(),
        invalidNickMarkers: parseMarkers(entry.invalidNickMarkers, DEFAULTS.invalidNickMarkers),
        telegramToken: String(pick(entry, 'telegramToken', DEFAULTS.telegramToken)).trim(),
        telegramChatId: String(pick(entry, 'telegramChatId', DEFAULTS.telegramChatId)).trim(),
        telegramSkip: pick(entry, 'telegramSkip', DEFAULTS.telegramSkip) === true,
        telegramProxy: pick(entry, 'telegramProxy', DEFAULTS.telegramProxy),
        telegramAutoXray: pick(entry, 'telegramAutoXray', DEFAULTS.telegramAutoXray) === true,
        telegramXrayCmd: String(pick(entry, 'telegramXrayCmd', DEFAULTS.telegramXrayCmd)).trim(),
    };

    return { bot, settings };
}
