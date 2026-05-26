/** Осмотр и сход с AFK — как в 4NAREK/4NAREK.mjs */

const LOOK_GCD_STEP = 0.15 * (Math.PI / 180);
const LOOK_SPIN_TURNS = 0.15;
const LOOK_SPIN_AVG_YAW_UNITS = 4;
const LOOK_SPIN_TIMEOUT_MIN_MS = 3000;
const LOOK_SPIN_TIMEOUT_MAX_MS = 4000;

export function lookAroundSpinStepCount(turns = LOOK_SPIN_TURNS) {
    const totalTurn = Math.PI * 2 * turns;
    return Math.ceil(totalTurn / (LOOK_SPIN_AVG_YAW_UNITS * LOOK_GCD_STEP));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Осмотр: мелкие GCD-шаги yaw/pitch, ~3–4 с (anti-AFK на FunTime).
 * @param {import('mineflayer').Bot} bot
 * @param {(msg: string) => void} log
 */
export async function lookAroundSpin(bot, log = console.log) {
    if (!bot?.entity) return;

    const startedAt = Date.now();
    const startPitch = bot.entity.pitch;
    const maxPitch = (Math.PI / 2) * 0.22;
    const turnDir = Math.random() < 0.5 ? -1 : 1;
    const steps = lookAroundSpinStepCount();
    const plannedDeg = LOOK_SPIN_TURNS * 360;
    const timeoutMs =
        LOOK_SPIN_TIMEOUT_MIN_MS +
        Math.floor(Math.random() * (LOOK_SPIN_TIMEOUT_MAX_MS - LOOK_SPIN_TIMEOUT_MIN_MS + 1));
    const deadline = startedAt + timeoutMs;
    let doneSteps = 0;

    for (let i = 0; i < steps; i++) {
        if (Date.now() >= deadline) break;

        const yawUnits = 2 + Math.floor(Math.random() * 5);
        const yaw = bot.entity.yaw + turnDir * yawUnits * LOOK_GCD_STEP;

        let pitch = bot.entity.pitch;
        if (Math.random() < 0.15) {
            const pitchUnits = 1 + Math.floor(Math.random() * 2);
            pitch += (Math.random() < 0.5 ? -1 : 1) * pitchUnits * LOOK_GCD_STEP;
            pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
        }

        await bot.look(yaw, pitch, false);
        doneSteps++;
    }

    const elapsedSec = (Date.now() - startedAt) / 1000;
    const timedOut = doneSteps < steps;
    log(
        `ОСМОТР ${doneSteps}/${steps} ~${plannedDeg.toFixed(0)}° ${elapsedSec.toFixed(1)}с` +
            (timedOut ? ` (таймаут ${(timeoutMs / 1000).toFixed(1)}с)` : '') +
            ` pitch ±${(Math.abs(bot.entity.pitch - startPitch) * 180) / Math.PI}°`,
    );
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ afk: boolean }} state
 * @param {(msg: string) => void} log
 */
export async function antiAfkIfNeeded(bot, state, log = console.log) {
    if (!state.afk) return;

    log('AFK → осмотр');

    if (bot.currentWindow) {
        await sleep(400 + Math.floor(Math.random() * 400));
        try {
            await bot.closeWindow(bot.currentWindow);
        } catch {
            /* ignore */
        }
    }

    await lookAroundSpin(bot, log);
    state.afk = false;
    log('AFK снят');
}
