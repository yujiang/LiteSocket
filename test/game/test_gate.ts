import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import { ErrorEnum, SocketParamEnum } from '../../src/client';
import { GameClient } from '../../src/game/GameClient';
import { GameServer } from '../../src/game/GameServer';
import { GateServer } from '../../src/game/GateServer';
import { MsgClientEnum, MsgGameGateEnum } from '../../src/game/MsgGame';
import { createSliceLogger } from '../../src/public/log';
import { deferred } from '../io_test_helpers';
import { waitUntil, within } from '../lite_test_helpers';

const player1 = 123;
const player2 = 456;

async function setup(context: TestContext) {
    const logger = createSliceLogger();
    const gate = new GateServer(10, logger, logger);
    // 业务编号故意不同于游戏服的连接编号，验证路由使用正确的编号。
    const game = new GameServer(100, logger, { checktimeout: true });
    const c1 = new GameClient('client1', logger, { checktimeout: true });
    const c2 = new GameClient('client2', logger, { checktimeout: true });
    context.after(() => {
        c1.destroy('test cleanup');
        c2.destroy('test cleanup');
        game.gate.destroy('test cleanup');
        gate.clients.close();
        gate.games.close();
    });
    assert.deepStrictEqual(await within(gate.start(0, {}, 0, {}), 'gate start'), [true]);
    assert(await within(game.start(`ws://127.0.0.1:${gate.games.io.port}`), 'game registration'));
    assert(gate.games.findGame(game.id), 'start must wait for game registration');
    const url = `ws://127.0.0.1:${gate.clients.io.port}`;
    assert(await within(c1.connectServer(url, () => {}), 'client1 connect'));
    assert(await within(c2.connectServer(url, () => {}), 'client2 connect'));
    return { gate, game, c1, c2 };
}

test('gate example logs in, enters game and chats in both directions', async context => {
    const { game, c1, c2 } = await setup(context);
    for (const [client, playerid] of [[c1, player1], [c2, player2]] as const) {
        assert.deepStrictEqual(await within(client.login(), 'login'), [ErrorEnum.ErrorOk]);
        assert.deepStrictEqual(await within(client.enterGame(game.id, playerid), 'enter game'), [ErrorEnum.ErrorOk]);
        assert.equal(game.findPlayer(playerid)?.clientid, client.getSocketId());
        assert.equal(game.findClient(client.getSocketId())?.playerid, playerid);
    }
    for (const [sender, receiver] of [[c1, c2], [c2, c1]]) {
        const received = deferred<[number, string]>();
        receiver.onMessage(MsgClientEnum.c_chat, (id: number, msg: string) => received.resolve([id, msg]));
        assert.deepStrictEqual(await within(sender.chat(receiver.playerid, 'hello world'), 'chat RPC'), [ErrorEnum.ErrorOk]);
        assert.deepStrictEqual(await within(received.promise, 'chat delivery'), [sender.playerid, 'hello world']);
        // 连接编号不能作为目标玩家编号使用。
        assert.deepStrictEqual(await within(sender.chat(receiver.getSocketId(), 'wrong id'), 'connection id rejected'),
            [ErrorEnum.ErrorError, 'des not in game']);
        assert.deepStrictEqual(await within(sender.chat(999999, 'missing player'), 'chat error'),
            [ErrorEnum.ErrorError, 'des not in game']);
    }
});

test('gate rejects entering before login and routing before entering', async context => {
    const { game, c1 } = await setup(context);
    assert.deepStrictEqual(await within(c1.enterGame(game.id, player1), 'enter without login'), [ErrorEnum.ErrorError, 'not login']);
    assert.deepStrictEqual(await within(c1.chat(1, 'not in game'), 'route without game'), [ErrorEnum.ErrorError, 'game not found']);
    assert.deepStrictEqual(await within(c1.login(), 'login'), [ErrorEnum.ErrorOk]);
    assert.deepStrictEqual(await within(c1.enterGame(999, player1), 'missing game'), [ErrorEnum.ErrorError, 'game not found']);
    assert.deepStrictEqual(await within(c1.exit(), 'exit without game'), [ErrorEnum.ErrorOk]);
    assert.equal(c1.logined, false);
});

test('gate translates events and keeps RPC sessions separate in both directions', async context => {
    const { game, c1 } = await setup(context);
    await within(c1.login(), 'login');
    await within(c1.enterGame(game.id, player1), 'enter game');
    const echo = 910100;
    // 消息处理器接收到的尾部包含当前连接的 session，只移除这一项。
    game.gate.onClientCallback(echo, (id: number, ...args: any[]) => [ErrorEnum.ErrorOk, id, ...args.slice(0, -1)]);
    c1.cbHandle.register(echo, (...args: any[]) => [ErrorEnum.ErrorOk, ...args.slice(0, -1)],
        null, SocketParamEnum.noSocket, 'game RPC');
    assert.deepStrictEqual(await within(c1.asendMsg(echo, 'request', 42), 'client to game RPC'),
        [ErrorEnum.ErrorOk, c1.getSocketId(), 'request', 42]);
    assert.deepStrictEqual(await within(game.gate.asendClient(c1.getSocketId(), [echo, 'reply', 43]), 'game to client RPC'),
        [ErrorEnum.ErrorOk, 'reply', 43]);
    const received = deferred<[number, string]>();
    game.gate.onClientMessage(echo, (id: number, text: string) => received.resolve([id, text]));
    c1.sendMsg(echo, 'ordinary message');
    assert.deepStrictEqual(await within(received.promise, 'client to game message'), [c1.getSocketId(), 'ordinary message']);
    assert.deepStrictEqual(c1.callback.callbacks, {});
    assert.deepStrictEqual(game.gate.callback.callbacks, {});
});

test('exit confirms player cleanup before another client sends a chat', async context => {
    const { gate, game, c1, c2 } = await setup(context);
    for (const [client, playerid] of [[c1, player1], [c2, player2]] as const) {
        await within(client.login(), 'login');
        await within(client.enterGame(game.id, playerid), 'enter game');
    }
    const clientid = c2.getSocketId();
    assert.deepStrictEqual(await within(c2.exit(), 'exit'), [ErrorEnum.ErrorOk]);
    assert.equal(game.findPlayer(player2), undefined);
    assert.equal(game.findClient(clientid), undefined);
    await waitUntil(() => !gate.clients.findById(clientid), 'client disconnect after exit');
    assert.equal(c2.logined, false);
    assert.equal(c2.gameid, 0);
    assert.equal(c2.playerid, 0);
    assert.deepStrictEqual(await within(c1.chat(player2, 'after exit'), 'chat after exit'),
        [ErrorEnum.ErrorError, 'des not in game']);
    const replacement = new GameClient('replacement-client', c2.logger, { checktimeout: true });
    context.after(() => replacement.destroy('test cleanup'));
    assert(await within(replacement.connectServer(`ws://127.0.0.1:${gate.clients.io.port}`, () => {}),
        'replacement client connect'));
    assert.deepStrictEqual(await within(replacement.login(), 'login again'), [ErrorEnum.ErrorOk]);
    assert.deepStrictEqual(await within(replacement.enterGame(game.id, player2), 'enter again'), [ErrorEnum.ErrorOk]);
});

test('client disconnect notifies game and releases both player indexes', async context => {
    const { gate, game, c1, c2 } = await setup(context);
    await within(c1.login(), 'login');
    await within(c1.enterGame(game.id, player1), 'enter game');
    const clientid = c1.getSocketId();
    c1.destroy('simulate client disconnect');
    await waitUntil(() => !gate.clients.findById(clientid) && !game.findPlayer(player1), 'disconnect cleanup');
    assert.equal(game.findClient(clientid), undefined);
    // 同一个玩家可以从另一个连接重新进入。
    await within(c2.login(), 'replacement login');
    assert.deepStrictEqual(await within(c2.enterGame(game.id, player1), 'replacement enter'), [ErrorEnum.ErrorOk]);
    assert.equal(game.findPlayer(player1)?.clientid, c2.getSocketId());
});

test('duplicate and invalid player ids do not overwrite existing players', async context => {
    const { game, c1, c2 } = await setup(context);
    await within(c1.login(), 'login1');
    await within(c2.login(), 'login2');
    await within(c1.enterGame(game.id, player1), 'enter1');
    assert.deepStrictEqual(await within(c2.enterGame(game.id, player1), 'duplicate player'),
        [ErrorEnum.ErrorError, 'not enterGame']);
    assert.equal(game.findPlayer(player1)?.clientid, c1.getSocketId());
    assert.equal(game.findClient(c2.getSocketId()), undefined);
    for (const playerid of [0, -1, 1.5]) {
        assert.deepStrictEqual(await within(c2.enterGame(game.id, playerid), 'invalid player'),
            [ErrorEnum.ErrorError, 'invalid playerid']);
    }
    assert.deepStrictEqual(await within(c2.enterGame(game.id, player2), 'enter valid player'), [ErrorEnum.ErrorOk]);
});

test('disconnect while entering does not leave a player in game', async context => {
    const { gate, game, c1 } = await setup(context);
    await within(c1.login(), 'login');
    const entered = deferred<void>();
    const release = deferred<void>();
    const clientid = c1.getSocketId();
    game.gate.onClientCallback(MsgGameGateEnum.gate2game_entergame, async (id: number, playerid: number) => {
        game.enterGame(id, playerid);
        entered.resolve();
        await release.promise;
        return [ErrorEnum.ErrorOk];
    });
    const entering = c1.enterGame(game.id, player1);
    await within(entered.promise, 'game entered before reply');
    c1.destroy('disconnect during enter');
    await waitUntil(() => !gate.clients.findById(clientid), 'gate sees disconnect');
    release.resolve();
    assert.equal((await within(entering, 'enter cancelled'))[0], ErrorEnum.Callback_disconnect);
    await waitUntil(() => !game.findPlayer(player1), 'late entry cleanup');
    assert.equal(game.findClient(clientid), undefined);
});
