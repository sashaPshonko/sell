import { appendFile, mkdir, stat, rename } from 'fs/promises';
import { dirname } from 'path';

const AUDIT_PATH = process.env.AUDIT_FILE || './audit.jsonl';
const AUDIT_MAX = 80 * 1024 * 1024;

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
        try {
            const st = await stat(AUDIT_PATH);
            if (st.size >= AUDIT_MAX) {
                const stamp = new Date().toISOString().slice(0, 10);
                await rename(AUDIT_PATH, `${AUDIT_PATH}.${stamp}`).catch(() => {});
            }
        } catch {
            /* no file yet */
        }
        await appendFile(AUDIT_PATH, line);
    } catch (e) {
        console.warn(`[audit] ${e.message}`);
    }
}
