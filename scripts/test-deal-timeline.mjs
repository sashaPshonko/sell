import { buildDealStatusTimeline } from '../lib/playerok-deal-sync.mjs';

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const deal1 = 'deal-aaaa-1111';
const deal2 = 'deal-bbbb-2222';

const messages = [
    {
        id: '1',
        text: '{{ITEM_PAID}}',
        createdAt: '2026-07-08T10:00:00.000Z',
        deal: { id: deal1, direction: 'OUT', status: 'PAID', user: { id: 'u1' } },
    },
    {
        id: '2',
        text: '{{ITEM_PAID}}',
        createdAt: '2026-07-08T10:01:00.000Z',
        deal: { id: deal2, direction: 'OUT', status: 'PAID', user: { id: 'u1' } },
    },
    {
        id: '3',
        text: '{{ITEM_SENT}}',
        createdAt: '2026-07-08T10:05:00.000Z',
        deal: { id: deal1, direction: 'OUT', status: 'SENT', user: { id: 'u1' } },
    },
    {
        id: '4',
        text: 'спасибо',
        createdAt: '2026-07-08T10:06:00.000Z',
        deal: { id: deal1, direction: 'OUT', status: 'PAID', user: { id: 'u1' } },
    },
    {
        id: '5',
        text: '{{ITEM_CONFIRMED}}',
        createdAt: '2026-07-08T10:07:00.000Z',
        deal: { id: deal1, direction: 'OUT', status: 'CONFIRMED', user: { id: 'u1' } },
    },
];

const timeline = buildDealStatusTimeline(messages);
assert(timeline.get(deal1)?.status === 'CONFIRMED', 'deal1 should stay CONFIRMED');
assert(timeline.get(deal2)?.status === 'PAID', 'deal2 should stay PAID, not inherit deal1');

console.log('OK: deal timeline isolates two orders');
