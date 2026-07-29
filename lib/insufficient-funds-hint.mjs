/**
 * Сообщение «мало валюты»: самый крупный 🎁 ≤ баланс − max бонус (10кк).
 */

import { BONUS_MAX_KK } from './pay-bonus.mjs';
import { coinsToKkFloor, getBotBalanceCoins } from './bot-balance.mjs';
import { resolveGiftLotUpToKk } from './profile-upsell.mjs';
import { buildInsufficientFundsHint } from '../messages.mjs';

/**
 * @param {object|null} client
 * @param {object} state
 * @param {object} order
 * @param {number|null} [balanceCoinsOverride]
 */
export async function composeInsufficientFundsHint(
    client,
    state,
    order,
    balanceCoinsOverride = null,
) {
    const coins =
        balanceCoinsOverride != null && Number.isFinite(Number(balanceCoinsOverride))
            ? Number(balanceCoinsOverride)
            : getBotBalanceCoins(state);
    const balanceKk = coins != null ? coinsToKkFloor(coins) : 0;
    // лот + макс. бонус 10кк должны влезть в баланс
    const capKk = Math.max(0, balanceKk - BONUS_MAX_KK);

    const sellerUserId = state?.sellerUserId || null;
    const sellerUsername = state?.sellerUsername ?? null;
    const ctx = {};

    if (client && sellerUserId && capKk > 0) {
        try {
            const gift = await resolveGiftLotUpToKk(
                client,
                order,
                sellerUserId,
                sellerUsername,
                capKk,
                { matchOrderPrice: false },
            );
            if (gift?.url && gift.kk > 0) {
                ctx.upsellUrl = gift.url;
                ctx.upsellKk = gift.kk;
            }
        } catch (e) {
            console.warn(`[sell] gift≤kk upsell: ${e.message}`);
        }
    }

    return buildInsufficientFundsHint(ctx);
}
