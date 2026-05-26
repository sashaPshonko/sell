/** Лог чата FunTime как в 4NAREK/4narek112 */

const ANSI = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

export function createChatLogger(username) {
    const tag = () => `${ANSI.cyan}[${username}]${ANSI.reset}`;

    function logChat(raw) {
        console.log(`${ANSI.dim}${tag()} 💬 ${raw}${ANSI.reset}`);
    }

    /** Как 4narek112: все строки чата, кроме спама AFK */
    function logServerMessage(text) {
        const raw = String(text);
        if (raw.includes('режиме AFK')) return;
        logChat(raw);
    }

    function logInfo(msg) {
        console.log(`${tag()} ${ANSI.bold}ℹ${ANSI.reset} ${msg}`);
    }

    function logOk(msg) {
        console.log(`${tag()} ${ANSI.green}✓${ANSI.reset} ${msg}`);
    }

    function logWarn(msg) {
        console.log(`${tag()} ${ANSI.yellow}⚠${ANSI.reset} ${msg}`);
    }

    function logErr(msg) {
        console.log(`${tag()} ${ANSI.red}✗${ANSI.reset} ${msg}`);
    }

    return { logChat, logServerMessage, logInfo, logOk, logWarn, logErr };
}
