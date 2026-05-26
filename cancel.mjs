/**
 * Отмена сделки на PlayerOK (mutation из DevTools при ручной отмене).
 * Пока нет cURL — задай CANCEL_DEAL_* в .env после captures/cancel-deal.graphql
 */
export async function cancelDealOnPlayerok(client, dealId) {
    if (process.env.AUTO_CANCEL_PLAYEROK !== '1') {
        return null;
    }

    const file = process.env.CANCEL_DEAL_MUTATION_FILE || './captures/cancel-deal.graphql';
    const op = process.env.CANCEL_DEAL_OPERATION || 'updateDeal';
    const status = process.env.CANCEL_DEAL_STATUS || 'ROLLED_BACK';

    let variables = { input: { id: dealId, status } };

    const varsRaw = process.env.CANCEL_DEAL_VARIABLES;
    if (varsRaw) {
        variables = JSON.parse(varsRaw.replaceAll('DEAL_ID', dealId));
    } else if (variables.input) {
        variables.input.status = status;
    }

    console.log(`[sell] PlayerOK отмена dealId=${dealId} (${op}, ${status})…`);
    return client.runMutationFromFile('CANCEL_DEAL_MUTATION_FILE', file, variables, op);
}
