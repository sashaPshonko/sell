/**
 * Закрытие сделки на PlayerOK (mutation updateDeal из DevTools).
 * SENT = «отправил», CONFIRMED = «выполнил» (сними отдельный cURL если статус другой).
 */
export async function confirmDealOnPlayerok(client, dealId) {
    const file = process.env.CONFIRM_DEAL_MUTATION_FILE || './captures/update-deal.graphql';
    const status = process.env.CONFIRM_DEAL_STATUS || 'CONFIRMED';
    let variables = { input: { id: dealId, status } };

    const varsRaw = process.env.CONFIRM_DEAL_VARIABLES;
    if (varsRaw) {
        variables = JSON.parse(varsRaw.replaceAll('DEAL_ID', dealId));
    }

    const op = process.env.CONFIRM_DEAL_OPERATION || 'updateDeal';
    console.log(`[sell] PlayerOK updateDeal ${status} dealId=${dealId}…`);
    return client.runMutationFromFile('CONFIRM_DEAL_MUTATION_FILE', file, variables, op);
}

/** Опционально: отметить «отправил» (status SENT) */
export async function markDealSentOnPlayerok(client, dealId) {
    const file = process.env.MARK_SENT_MUTATION_FILE || './captures/update-deal.graphql';
    const op = process.env.MARK_SENT_OPERATION || 'updateDeal';
    const variables = { input: { id: dealId, status: 'SENT' } };
    console.log(`[sell] PlayerOK updateDeal SENT dealId=${dealId}…`);
    return client.runMutationFromFile('MARK_SENT_MUTATION_FILE', file, variables, op);
}
