/**
 * FunTime шлёт кастомные item components/NBT → protodef падает на Slot
 * с "array size is abnormally large". Это не PartialReadError, поэтому
 * FullPacketParser делает cb(e) → error на stream → re-pipe → keepalive
 * начинает сыпаться. Помечаем такие ошибки как partialRead и просто
 * дропаем битый пакет, не трогая пайплайн.
 */

const SOFT_MSG = [
    'array size is abnormally large',
    'Invalid tag',
    'PartialReadError',
    'Compressed data is corrupt',
    'unexpected end of buffer',
    'Read error for undefined',
    'uncompressed length',
    'problem inflating chunk',
];

export function isSoftPacketParseFailure(err) {
    if (!err) return false;
    if (err.partialReadError) return true;
    const msg = String(err.message ?? err);
    return SOFT_MSG.some((s) => msg.includes(s));
}

function patchDeserializer(deserializer, log) {
    if (!deserializer || deserializer._ftSlotResilience) return;
    deserializer._ftSlotResilience = true;

    const orig = deserializer.parsePacketBuffer.bind(deserializer);
    deserializer.parsePacketBuffer = (buffer) => {
        try {
            return orig(buffer);
        } catch (e) {
            if (isSoftPacketParseFailure(e)) {
                e.partialReadError = true;
                const now = Date.now();
                if (typeof log?.info === 'function') {
                    if (!deserializer._ftSoftNoiseAt || now - deserializer._ftSoftNoiseAt > 8000) {
                        deserializer._ftSoftNoiseAt = now;
                        log.info('сломанный Slot/NBT от FunTime — пакет пропущен');
                    }
                }
            }
            throw e;
        }
    };
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ info?: (s: string) => void }} [log]
 */
export function setupProtocolResilience(bot, log) {
    const client = bot?._client;
    if (!client) return;

    patchDeserializer(client.deserializer, log);

    if (client._ftProtocolResilience) return;
    client._ftProtocolResilience = true;

    const origSetSerializer = client.setSerializer.bind(client);
    client.setSerializer = (state) => {
        origSetSerializer(state);
        patchDeserializer(client.deserializer, log);
    };
}
