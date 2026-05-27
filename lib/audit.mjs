import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

const AUDIT_PATH = process.env.AUDIT_FILE || './audit.jsonl';

/** Дополняемый журнал — не обнуляется при `> sell.log` */
export async function audit(event, data = {}) {
    const line =
        JSON.stringify({
            ts: new Date().toISOString(),
            event,
            ...data,
        }) + '\n';
    try {
        await mkdir(dirname(AUDIT_PATH), { recursive: true });
        await appendFile(AUDIT_PATH, line);
    } catch (e) {
        console.warn(`[audit] ${e.message}`);
    }
}
