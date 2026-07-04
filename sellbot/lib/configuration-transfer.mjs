/** Funtime/Bungee transfer при /anXXX — не слать gameplay-пакеты в configuration phase. */

const CONFIG_BLOCKED_PACKETS = new Set([
    'position', 'look', 'position_look', 'flying',
    'chat', 'chat_command', 'chat_command_signed', 'chat_message',
    'window_click', 'close_window',
    'arm_animation', 'entity_action',
    'held_item_slot', 'set_creative_slot',
]);

let configTransferStartedAt = 0;

function ensureRegistryDimensionStub(bot) {
    if (Array.isArray(bot.registry.dimensionsArray) && bot.registry.dimensionsArray.length > 0) {
        return;
    }
    const fallback = { name: 'minecraft:overworld', minY: -64, height: 384 };
    bot.registry.dimensionsArray = Array.from({ length: 16 }, () => fallback);
    bot.registry.dimensionsByName ??= { overworld: fallback };
}

export function isInConfigurationTransfer(bot) {
    return bot?._client?.state === 'configuration';
}

export function configurationTransferAgeMs() {
    if (!configTransferStartedAt) return 0;
    return Date.now() - configTransferStartedAt;
}

export function setupConfigurationTransferFix(bot, log) {
    const client = bot._client;
    if (!client) return;

    const origLoadDimensionCodec = bot.registry.loadDimensionCodec.bind(bot.registry);
    bot.registry.loadDimensionCodec = (codec) => {
        try {
            origLoadDimensionCodec(codec);
        } catch {
            ensureRegistryDimensionStub(bot);
        }
    };

    client.prependListener('login', () => ensureRegistryDimensionStub(bot));
    client.prependListener('respawn', () => ensureRegistryDimensionStub(bot));

    const PACK_ACCEPTED = 3;
    const PACK_LOADED = 0;
    let blockSelectKnownPacksWrite = false;

    const origWrite = client.write.bind(client);
    client.write = (name, params) => {
        if (client.state === 'configuration' && CONFIG_BLOCKED_PACKETS.has(name)) {
            return;
        }
        if (blockSelectKnownPacksWrite && name === 'select_known_packs') {
            return;
        }
        return origWrite(name, params);
    };

    client.on('start_configuration', () => {
        configTransferStartedAt = Date.now();
        blockSelectKnownPacksWrite = false;
        bot.physicsEnabled = false;
        log.info('transfer → configuration phase (жду finish_configuration)');
    });

    client.on('finish_configuration', () => {
        configTransferStartedAt = 0;
        blockSelectKnownPacksWrite = false;
        bot.physicsEnabled = true;
        log.ok('transfer → configuration завершён');
    });

    client.on('cookie_request', (data) => {
        if (client.state !== 'configuration') return;
        log.info(`config → cookie_request: ${data.cookie}`);
        origWrite('cookie_response', { key: data.cookie });
    });

    client.prependListener('add_resource_pack', (data) => {
        if (client.state !== 'configuration') return;
        log.info('config → add_resource_pack, принимаю');
        origWrite('resource_pack_receive', { uuid: data.uuid, result: PACK_ACCEPTED });
        origWrite('resource_pack_receive', { uuid: data.uuid, result: PACK_LOADED });
    });

    client.prependListener('select_known_packs', (data) => {
        if (client.state !== 'configuration') return;
        const packs = (data.packs ?? []).map((p) => ({
            namespace: p.namespace,
            id: p.id,
            version: p.version,
        }));
        log.info(`config → select_known_packs (${packs.length})`);
        origWrite('select_known_packs', { packs });
        blockSelectKnownPacksWrite = true;
    });

    client.on('disconnect', (data) => {
        if (client.state !== 'configuration') return;
        log.warn(`config → disconnect: ${JSON.stringify(data.reason ?? data)}`);
    });

    bot.on('resourcePack', () => {
        if (client.state === 'configuration') return;
        bot.acceptResourcePack();
    });
}
