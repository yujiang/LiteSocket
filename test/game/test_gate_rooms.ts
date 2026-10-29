import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ErrorEnum, MsgId } from '../../src/client';
import { GameClient } from '../../src/game/GameClient';
import { GameServer } from '../../src/game/GameServer';
import { GateServer } from '../../src/game/GateServer';
import { MsgClientEnum } from '../../src/game/MsgGame';
import { createSliceLogger } from '../../src/public/log';
import { deferred } from '../io_test_helpers';
import { within } from '../lite_test_helpers';

test('game room namespaces cannot collide and leave/dismiss stop broadcasts', async context => {
    const logger = createSliceLogger();
    const gate = new GateServer(10, logger, logger);
    const games = [1, 12].map(id => new GameServer(id, logger, { checktimeout: true }));
    const clients = [0, 1].map(id => new GameClient(`room-client-${id}`, logger, { checktimeout: true }));
    context.after(() => {
        clients.forEach(client => client.destroy('test cleanup'));
        games.forEach(game => game.gate.destroy('test cleanup'));
        gate.clients.close();
        gate.games.close();
    });
    assert.deepStrictEqual(await within(gate.start(0, {}, 0, {}), 'gate start'), [true]);
    const received: Array<Array<[number, string]>> = [[], []];
    for (const [index, game] of games.entries()) {
        assert(await within(game.start(`ws://127.0.0.1:${gate.games.io.port}`), 'game registration'));
        const client = clients[index];
        assert(await within(client.connectServer(`ws://127.0.0.1:${gate.clients.io.port}`, () => {}), 'client connect'));
        await within(client.login(), 'login');
        assert.deepStrictEqual(await within(client.enterGame(game.id, 123 + index), 'enter game'), [ErrorEnum.ErrorOk]);
        client.onBroadcast(MsgClientEnum.bc_chat, (id: number, text: string) => { received[index].push([id, text]); });
    }
    async function flush() {
        // 同一连接的查询响应确认之前的房间操作已在 Gate 执行。
        for (const game of games) {
            await within(game.gate.asendCallback(MsgId.MSG_SYSTEM_QUERYHTTPSERVER, 'name'), 'room operation barrier');
        }
        await Promise.all(clients.map(async client => {
            const barrier = deferred<void>();
            client.socket.on('room-barrier', () => barrier.resolve());
            gate.clients.findById(client.getSocketId()).emit('room-barrier');
            await within(barrier.promise, 'broadcast delivery barrier');
        }));
    }
    // 原先的 gameid + room 拼接会把 1/23 和 12/3 合并成 123。
    games[0].opRoom('join', '23', clients[0].getSocketId());
    games[1].opRoom('join', '3', clients[1].getSocketId());
    await flush();
    games[0].bcRoom('23', MsgClientEnum.bc_chat, 123, 'isolated');
    await flush();
    assert.deepStrictEqual(received, [[[123, 'isolated']], []]);
    games[0].opRoom('leave', '23', clients[0].getSocketId());
    games[0].bcRoom('23', MsgClientEnum.bc_chat, 123, 'after leave');
    await flush();
    assert.deepStrictEqual(received, [[[123, 'isolated']], []]);
    games[0].opRoom('join', '23', clients[0].getSocketId());
    games[0].opRoom('dismiss', '23', 0);
    games[0].bcRoom('23', MsgClientEnum.bc_chat, 123, 'after dismiss');
    await flush();
    assert.deepStrictEqual(received, [[[123, 'isolated']], []]);
    assert.deepStrictEqual(await within(clients[1].bcChat('own world'), 'world broadcast'), [ErrorEnum.ErrorOk]);
    await flush();
    assert.deepStrictEqual(received, [[[123, 'isolated']], [[124, 'own world']]]);
});
