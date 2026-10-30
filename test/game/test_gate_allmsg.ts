import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import { ErrorEnum } from '../../src/client';
import { GameClient } from '../../src/game/GameClient';
import { GameServer } from '../../src/game/GameServer';
import { GateServer } from '../../src/game/GateServer';
import { MsgClientEnum, MsgGameGateEnum } from '../../src/game/MsgGame';
import { createSliceLogger } from '../../src/public/log';
import { deferred } from '../io_test_helpers';
import { waitUntil, within } from '../lite_test_helpers';

test('game message enums are exercised through the gate', async context => {
    const logger = createSliceLogger();
    const gate = new GateServer(10, logger, logger);
    const game = new GameServer(100, logger, { checktimeout: true });
    const client1 = new GameClient('all-message-client-1', logger, { checktimeout: true });
    const client2 = new GameClient('all-message-client-2', logger, { checktimeout: true });
    const client3 = new GameClient('all-message-client-3', logger, { checktimeout: true });
    context.after(() => {
        client1.destroy('test cleanup');
        client2.destroy('test cleanup');
        client3.destroy('test cleanup');
        game.gate.destroy('test cleanup');
        gate.clients.close();
        gate.games.close();
    });

    assert.deepStrictEqual(await within(gate.start(0, {}, 0, {}), 'gate start'), [true]);
    assert(await within(game.start(`ws://127.0.0.1:${gate.games.io.port}`), 'game registration'));
    assert(gate.games.findGame(game.id), 'game2gate_info registers the game with the gate');

    const url = `ws://127.0.0.1:${gate.clients.io.port}`;
    assert((await within(client1.connectServer(url, () => {}), 'client1 connect'))[0]);
    assert((await within(client2.connectServer(url, () => {}), 'client2 connect'))[0]);
    assert((await within(client3.connectServer(url, () => {}), 'client3 connect'))[0]);

    assert.deepStrictEqual(await within(client1.login(), 'gate_login'), [ErrorEnum.ErrorOk]);
    assert.deepStrictEqual(await within(client2.login(), 'gate_login client2'), [ErrorEnum.ErrorOk]);
    assert.deepStrictEqual(await within(client1.enterGame(game.id, 123), 'gate_entergame'), [ErrorEnum.ErrorOk]);
    assert.deepStrictEqual(await within(client2.enterGame(game.id, 456), 'gate2game_entergame client2'),
        [ErrorEnum.ErrorOk]);

    const chat = deferred<[number, string]>();
    client2.onMessage(MsgClientEnum.c_chat, (playerid: number, message: string) => chat.resolve([playerid, message]));
    assert.deepStrictEqual(await within(client1.chatDes(456, 'all messages'), 'game_chat'), [ErrorEnum.ErrorOk]);
    assert.deepStrictEqual(await within(chat.promise, 'c_chat delivery'), [123, 'all messages']);

    const broadcasts = [client1, client2, client3].map(() => [] as Array<[number, string]>);
    for (const [index, client] of [client1, client2, client3].entries()) {
        client.onBroadcast(MsgClientEnum.bc_chat, (playerid: number, message: string) => {
            broadcasts[index].push([playerid, message]);
        });
    }
    assert.deepStrictEqual(await within(client1.bcChat('world chat'), 'game_bcchat'), [ErrorEnum.ErrorOk]);
    await waitUntil(() => broadcasts[0].length === 1 && broadcasts[1].length === 1, 'bc_chat delivery');
    const barrier = deferred<void>();
    client3.socket.on('broadcast-barrier', () => barrier.resolve());
    gate.clients.findById(client3.getSocketId()).emit('broadcast-barrier');
    await within(barrier.promise, 'non-member broadcast barrier');
    assert.deepStrictEqual(broadcasts, [[[123, 'world chat']], [[123, 'world chat']], []]);
    assert.equal(gate.clients.io.getRoom(`${game.id}:world`)?.size(), 2);

    const disconnectedClientId = client1.getSocketId();
    client1.destroy('test disconnect');
    await waitUntil(
        () => !gate.clients.findById(disconnectedClientId) && !game.findClient(disconnectedClientId),
        'gate2game_disconnect cleanup',
    );
    assert.equal(game.findPlayer(123), undefined);

    assert.deepStrictEqual(await within(client2.exit(), 'gate_exit and gate2game_exit'), [ErrorEnum.ErrorOk]);
    assert.equal(game.findPlayer(456), undefined);
    assert.equal(game.findClient(client2.getSocketId()), undefined);

    assert.deepStrictEqual(await within(client3.login(), 'game2gate_exit setup login'), [ErrorEnum.ErrorOk]);
    assert.deepStrictEqual(await within(client3.enterGame(game.id, 789), 'game2gate_exit setup enter'),
        [ErrorEnum.ErrorOk]);
    const kickedClientId = client3.getSocketId();
    assert.equal(game.exitGame(789, 'kickoff'), true);
    await waitUntil(
        () => !gate.clients.findById(kickedClientId),
        'game2gate_exit disconnects the client',
    );
    assert.equal(game.findPlayer(789), undefined);
    assert.equal(game.findClient(kickedClientId), undefined);

    // Keep the explicit message-name lists in sync when protocol messages are added.
    assert.deepStrictEqual(
        Object.entries(MsgGameGateEnum)
            .filter(([name, value]) => typeof value === 'number' && !['Max', 'start', 'end'].includes(name))
            .map(([name]) => name),
        ['game2gate_info', 'gate2game_entergame', 'gate2game_exit', 'gate2game_disconnect', 'game2gate_exit'],
    );
    assert.deepStrictEqual(
        Object.entries(MsgClientEnum)
            .filter(([name, value]) => typeof value === 'number' && !['Max', 'start', 'end'].includes(name))
            .map(([name]) => name),
        ['gate_login', 'gate_entergame', 'gate_exit', 'game_chat', 'game_bcchat', 'c_chat', 'bc_chat'],
    );
});
