/** Ошибки протокола Funtime/mineflayer — бот при этом жив, не падать. */
export function isIgnorableProtocolNoise(err) {
    if (!err) return false;
    const name = err.name ?? '';
    const stack = String(err.stack ?? '');
    const msg = String(err.message ?? err);
    if (name === 'PartialReadError' || msg.includes('PartialReadError')) return true;
    if (stack.includes('packet_world_particles')) return true;
    if (stack.includes('loadDimensionCodec') || stack.includes('prismarine-nbt/nbt.js')) return true;
    if (stack.includes('handleRespawnPacketData')) return true;
    if (stack.includes('prismarine-chat') || stack.includes('ChatMessage.fromNetwork')) return true;
    if (msg.includes('Cannot convert undefined or null to object')) return true;
    if (msg.includes('uncompressed length') || msg.includes('problem inflating chunk')) return true;
    if (msg.includes('client timed out')) return true;
    if (msg.includes("reading 'translate'")) return true;
    return false;
}
