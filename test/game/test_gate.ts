import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import { ErrorEnum, SocketParamEnum } from '../../src/client';
import { chat_error, entergame_error, exit_error, login_error, game2gate_info_error } from '../../src/game/ErrorGame';
import { GameClient } from '../../src/game/client/GameClient';
import { GameServer } from '../../src/game/game/GameServer';
import { GateServer } from '../../src/game/gate/GateServer';
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
        c1.client.destroy('test cleanup');
        c2.client.destroy('test cleanup');
        game.gate.destroy('test cleanup');
        gate.clients.close();
        gate.games.close();
    });
    assert.deepStrictEqual(await within(gate.start(0, {}, 0, {}), 'gate start'), [true]);
    assert.equal(await within(game.start(`ws://127.0.0.1:${gate.games.io.port}`), 'game registration'), ErrorEnum.ErrorOk);
    assert(gate.games.findGame(game.id), 'start must wait for game registration');
    const url = `ws://127.0.0.1:${gate.clients.io.port}`;
    assert((await within(c1.client.connectServer(url, () => {}), 'client1 connect'))[0]);
    assert((await within(c2.client.connectServer(url, () => {}), 'client2 connect'))[0]);
    return { gate, game, c1, c2 };
}

test('gate example logs in, enters game and chats in both directions', async context => {
    const { game, c1, c2 } = await setup(context);
    for (const [client, playerid] of [[c1, player1], [c2, player2]] as const) {
        assert.deepStrictEqual(await within(client.player.login(), 'login'), [ErrorEnum.ErrorOk]);
        assert.deepStrictEqual(await within(client.player.enterGame(game.id, playerid), 'enter game'), [ErrorEnum.ErrorOk]);
        assert.equal(game.context.players.findPlayer(playerid)?.clientid, client.client.getSocketId());
        assert.equal(game.context.players.findClient(client.client.getSocketId())?.playerid, playerid);
    }
    for (const [sender, receiver] of [[c1, c2], [c2, c1]]) {
        const received = deferred<[number, string]>();
        receiver.client.onMessage(MsgClientEnum.c_chat, (id: number, msg: string) => received.resolve([id, msg]));
        assert.equal(await within(sender.player.chatDes(receiver.player.playerid, 'hello world'), 'chat RPC'), ErrorEnum.ErrorOk);
        assert.deepStrictEqual(await within(received.promise, 'chat delivery'), [sender.player.playerid, 'hello world']);
        // 连接编号不能作为目标玩家编号使用。
        assert.equal(await within(sender.player.chatDes(receiver.client.getSocketId(), 'wrong id'), 'connection id rejected'),
            chat_error.des_not_ingame);
        assert.equal(await within(sender.player.chatDes(999999, 'missing player'), 'chat error'),
            chat_error.des_not_ingame);
    }
});

test('gate rejects entering before login and routing before entering', async context => {
    const { game, c1 } = await setup(context);
    assert.deepStrictEqual(await within(c1.player.enterGame(game.id, player1), 'enter without login'), [entergame_error.not_login]);
    assert.equal(await within(c1.player.chatDes(1, 'not in game'), 'route without game'), ErrorEnum.ErrorError);
    assert.deepStrictEqual(await within(c1.player.login(), 'login'), [ErrorEnum.ErrorOk]);
    assert.deepStrictEqual(await within(c1.player.enterGame(999, player1), 'missing game'), [entergame_error.game_not_found]);
    assert.deepStrictEqual(await within(c1.player.exit(), 'exit without game'), [ErrorEnum.ErrorOk]);
    assert.equal(c1.player.logined, false);
});

test('gate translates events and keeps RPC sessions separate in both directions', async context => {
    const { game, c1 } = await setup(context);
    await within(c1.player.login(), 'login');
    await within(c1.player.enterGame(game.id, player1), 'enter game');
    const echo = 910100;
    // 消息处理器接收到的尾部包含当前连接的 session，只移除这一项。
    game.gate.onClientCallback(echo, (id: number, ...args: any[]) => [ErrorEnum.ErrorOk, id, ...args.slice(0, -1)]);
    c1.client.cbHandle.register(echo, (...args: any[]) => [ErrorEnum.ErrorOk, ...args.slice(0, -1)],
        null, SocketParamEnum.noSocket, 'game RPC');
    assert.deepStrictEqual(await within(c1.client.asendCallback(echo, 'request', 42), 'client to game RPC'),
        [ErrorEnum.ErrorOk, c1.client.getSocketId(), 'request', 42]);
    assert.deepStrictEqual(await within(game.gate.asendClient(c1.client.getSocketId(), [echo, 'reply', 43]), 'game to client RPC'),
        [ErrorEnum.ErrorOk, 'reply', 43]);
    const received = deferred<[number, string]>();
    game.gate.onClientMessage(echo, (id: number, text: string) => received.resolve([id, text]));
    c1.client.sendMsg(echo, 'ordinary message');
    assert.deepStrictEqual(await within(received.promise, 'client to game message'), [c1.client.getSocketId(), 'ordinary message']);
    assert.deepStrictEqual(c1.client.callback.callbacks, {});
    assert.deepStrictEqual(game.gate.callback.callbacks, {});
});

test('exit confirms player cleanup before another client sends a chat', async context => {
    const { gate, game, c1, c2 } = await setup(context);
    for (const [client, playerid] of [[c1, player1], [c2, player2]] as const) {
        await within(client.player.login(), 'login');
        await within(client.player.enterGame(game.id, playerid), 'enter game');
    }
    const clientid = c2.client.getSocketId();
    assert.deepStrictEqual(await within(c2.player.exit(), 'exit'), [ErrorEnum.ErrorOk]);
    assert.equal(game.context.players.findPlayer(player2), undefined);
    assert.equal(game.context.players.findClient(clientid), undefined);
    await waitUntil(() => !gate.clients.findById(clientid), 'client disconnect after exit');
    assert.equal(c2.player.logined, false);
    assert.equal(c2.player.gameid, 0);
    assert.equal(c2.player.playerid, 0);
    assert.equal(await within(c1.player.chatDes(player2, 'after exit'), 'chat after exit'), chat_error.des_not_ingame);
    const replacement = new GameClient('replacement-client', c2.client.logger, { checktimeout: true });
    context.after(() => replacement.client.destroy('test cleanup'));
    assert((await within(replacement.client.connectServer(`ws://127.0.0.1:${gate.clients.io.port}`, () => {}),
        'replacement client connect'))[0]);
    assert.deepStrictEqual(await within(replacement.player.login(), 'login again'), [ErrorEnum.ErrorOk]);
    assert.deepStrictEqual(await within(replacement.player.enterGame(game.id, player2), 'enter again'), [ErrorEnum.ErrorOk]);
});

test('client disconnect notifies game and releases both player indexes', async context => {
    const { gate, game, c1, c2 } = await setup(context);
    await within(c1.player.login(), 'login');
    await within(c1.player.enterGame(game.id, player1), 'enter game');
    const clientid = c1.client.getSocketId();
    c1.client.destroy('simulate client disconnect');
    await waitUntil(() => !gate.clients.findById(clientid) && !game.context.players.findPlayer(player1), 'disconnect cleanup');
    assert.equal(game.context.players.findClient(clientid), undefined);
    // 同一个玩家可以从另一个连接重新进入。
    await within(c2.player.login(), 'replacement login');
    assert.deepStrictEqual(await within(c2.player.enterGame(game.id, player1), 'replacement enter'), [ErrorEnum.ErrorOk]);
    assert.equal(game.context.players.findPlayer(player1)?.clientid, c2.client.getSocketId());
});

test('duplicate and invalid player ids do not overwrite existing players', async context => {
    const { game, c1, c2 } = await setup(context);
    await within(c1.player.login(), 'login1');
    await within(c2.player.login(), 'login2');
    await within(c1.player.enterGame(game.id, player1), 'enter1');
    assert.deepStrictEqual(await within(c2.player.enterGame(game.id, player1), 'duplicate player'),
        [entergame_error.gameserver_player_in_game]);
    assert.equal(game.context.players.findPlayer(player1)?.clientid, c1.client.getSocketId());
    assert.equal(game.context.players.findClient(c2.client.getSocketId()), undefined);
    for (const playerid of [0, -1, 1.5]) {
        assert.deepStrictEqual(await within(c2.player.enterGame(game.id, playerid), 'invalid player'),
            [entergame_error.invalid_playerid]);
    }
    assert.deepStrictEqual(await within(c2.player.enterGame(game.id, player2), 'enter valid player'), [ErrorEnum.ErrorOk]);
});

test('disconnect while entering does not leave a player in game', async context => {
    const { gate, game, c1 } = await setup(context);
    await within(c1.player.login(), 'login');
    const entered = deferred<void>();
    const release = deferred<void>();
    const clientid = c1.client.getSocketId();
    game.gate.onClientCallback(MsgGameGateEnum.gate2game_entergame, async (id: number, playerid: number) => {
        game.context.players.enterGame(id, playerid);
        entered.resolve();
        await release.promise;
        return [ErrorEnum.ErrorOk];
    });
    const entering = c1.player.enterGame(game.id, player1);
    await within(entered.promise, 'game entered before reply');
    c1.client.destroy('disconnect during enter');
    await waitUntil(() => !gate.clients.findById(clientid), 'gate sees disconnect');
    release.resolve();
    assert.equal((await within(entering, 'enter cancelled'))[0], ErrorEnum.Callback_disconnect);
    await waitUntil(() => !game.context.players.findPlayer(player1), 'late entry cleanup');
    assert.equal(game.context.players.findClient(clientid), undefined);
});

test('concurrent enter and exit cannot leave one connection in two games', async context => {
    const { gate, game, c1 } = await setup(context);
    const other = new GameServer(200, c1.client.logger, { checktimeout: true });
    context.after(() => other.gate.destroy('test cleanup'));
    assert.equal(await within(other.start(`ws://127.0.0.1:${gate.games.io.port}`), 'second game'), ErrorEnum.ErrorOk);
    await within(c1.player.login(), 'login');
    const entered = deferred<void>();
    const release = deferred<void>();
    context.after(() => release.resolve());
    game.gate.onClientCallback(MsgGameGateEnum.gate2game_entergame, async (clientid: number, playerid: number) => {
        game.context.players.enterGame(clientid, playerid);
        entered.resolve();
        await release.promise;
        return [ErrorEnum.ErrorOk];
    });
    const first = c1.player.enterGame(game.id, player1);
    await within(entered.promise, 'first entry pending');
    assert.deepStrictEqual(await within(c1.player.enterGame(other.id, player2), 'concurrent entry'),
        [entergame_error.already_in_game]);
    assert.deepStrictEqual(await within(c1.player.exit(), 'exit during entry'), [exit_error.entering_game]);
    release.resolve();
    assert.deepStrictEqual(await within(first, 'first entry result'), [ErrorEnum.ErrorOk]);
    assert(game.context.players.findPlayer(player1));
    assert.equal(other.context.players.findPlayer(player2), undefined);
    assert.equal(c1.player.gameid, game.id);
});

test('business error codes preserve player indexes and login state', async context => {
    const { gate, game, c1, c2 } = await setup(context);
    assert.deepStrictEqual(await c1.player.asendGate(MsgClientEnum.gate_exit), [ErrorEnum.ErrorOk]);
    assert.equal(gate.clients.findById(c1.client.getSocketId()).customData.logined, false);
    await c1.player.login();
    assert.deepStrictEqual(await c1.player.login(), [login_error.logined]);
    assert(c1.player.logined);
    await c1.player.enterGame(game.id, player1);
    const player = game.context.players.findPlayer(player1);
    assert(player);
    assert.equal(game.context.players.enterGame(player.clientid, player2), entergame_error.gameserver_client_in_game);
    assert.equal(game.context.players.findPlayer(player2), undefined);
    assert.equal(game.context.players.findClient(player.clientid), player);
    assert.equal(game.context.players.exitClient(999999), exit_error.gameserver_not_found_client);
    assert.equal(game.context.players.findPlayer(player1), player);
    assert.deepStrictEqual(await c1.player.enterGame(game.id, player2), [entergame_error.already_in_game]);
    assert.equal(c1.player.playerid, player1);
    await c2.player.login();
    for (const invalid of [Number.MAX_SAFE_INTEGER + 1, '123', null]) {
        assert.deepStrictEqual(await c2.player.enterGame(game.id, invalid as number), [entergame_error.invalid_playerid]);
    }
    assert.deepStrictEqual(await c2.player.enterGame(game.id, player2), [ErrorEnum.ErrorOk]);
    const gameSocket = gate.games.findGame(game.id);
    assert.equal(await gameSocket.asendCallbacke(MsgClientEnum.game_chat, 999999, player1, 'missing sender'),
        chat_error.client_not_ingame);
    assert.equal(await gameSocket.asendCallbacke(MsgClientEnum.game_bcchat, 999999, 'missing sender', 'world'),
        chat_error.client_not_ingame);
    assert.equal(await gameSocket.asendCallbacke(MsgGameGateEnum.gate2game_exit, 999999),
        exit_error.gameserver_not_found_client);
    assert.equal(game.context.players.findPlayer(player1), player);
});

test('exit after game connection loss clears stale gate and client state', async context => {
    const { gate, game, c1 } = await setup(context);
    await c1.player.login();
    await c1.player.enterGame(game.id, player1);
    game.gate.socket.disconnect();
    await waitUntil(() => !gate.games.findGame(game.id), 'game disconnected');
    const custom = gate.clients.findById(c1.client.getSocketId()).customData;
    assert.deepStrictEqual(await c1.player.exit(), [ErrorEnum.ErrorOk]);
    assert.equal(custom.logined, false);
    assert.equal(custom.gameid, 0);
    assert.equal(custom.playerid, 0);
    assert.equal(c1.player.logined, false);
    assert.equal(c1.player.gameid, 0);
    assert.equal(c1.player.playerid, 0);
});

test('duplicate game registration does not replace the existing game', async context => {
    const { gate, game, c1 } = await setup(context);
    const original = gate.games.findGame(game.id);
    const duplicate = new GameServer(game.id, c1.client.logger, { checktimeout: true });
    context.after(() => duplicate.gate.destroy('test cleanup'));
    assert.equal(await duplicate.start(`ws://127.0.0.1:${gate.games.io.port}`), game2gate_info_error.Game_already_registered);
    assert.equal(gate.games.findGame(game.id), original);
    await c1.player.login();
    assert.deepStrictEqual(await c1.player.enterGame(game.id, player1), [ErrorEnum.ErrorOk]);
    assert(game.context.players.findPlayer(player1));
    assert.equal(duplicate.context.players.findPlayer(player1), undefined);
});

test('broadcast errors do not deliver messages and rate limit recovers', async context => {
    const { game, c1 } = await setup(context);
    await c1.player.login();
    await c1.player.enterGame(game.id, player1);
    const player = game.context.players.findPlayer(player1);
    const received: string[] = [];
    c1.client.onBroadcast(MsgClientEnum.bc_chat, (_id: number, message: string) => { received.push(message); });
    player.prevBCTime = -Infinity;
    assert.deepStrictEqual(await c1.player.bcChat('invalid', 'missing'), [chat_error.bcChat_unknown_channel]);
    player.prevBCTime = -Infinity;
    assert.deepStrictEqual(await c1.player.bcChat('first', 'games'), [ErrorEnum.ErrorOk]);
    assert.deepStrictEqual(await c1.player.bcChat('blocked', 'games'), [chat_error.bcChat_too_fast]);
    player.prevBCTime -= 1001;
    assert.deepStrictEqual(await c1.player.bcChat('recovered', 'games'), [ErrorEnum.ErrorOk]);
    await waitUntil(() => received.length >= 2, 'accepted broadcasts');
    assert.deepStrictEqual(received, ['first', 'recovered']);
});

for (const failure of ['timeout', 'disconnect'] as const) {
    test(`entry ${failure} clears entering and does not commit gate player state`, async context => {
        const { gate, game, c1 } = await setup(context);
        await c1.player.login();
        const entered = deferred<void>();
        const release = deferred<void>();
        context.after(() => release.resolve());
        const clientid = c1.client.getSocketId();
        game.gate.onClientCallback(MsgGameGateEnum.gate2game_entergame, async (id: number, playerid: number) => {
            game.context.players.enterGame(id, playerid);
            entered.resolve();
            await release.promise;
            return ErrorEnum.ErrorOk;
        });
        const pending = c1.player.enterGame(game.id, player1);
        await within(entered.promise, 'player created before reply');
        const custom = gate.clients.findById(clientid).customData;
        assert.equal(custom.entering, true);
        const session = gate.games.findGame(game.id).session;
        if (failure === 'timeout') {
            const entry = Object.values(session.callbacks)[0];
            assert.equal(entry[4], 5000);
            assert.equal(session.checkTimeout(entry[3] + 5001), 1);
        } else {
            // Keep the game offline until the failed entry has been observed.
            game.gate.socket.disconnect();
        }
        const expected = failure === 'timeout' ? ErrorEnum.Callback_timeout : ErrorEnum.Callback_disconnect;
        assert.deepStrictEqual(await within(pending, 'failed entry'), [expected]);
        assert.equal(custom.entering, false);
        assert.equal(custom.gameid, 0);
        assert.equal(custom.playerid, 0);
        assert.equal(c1.player.gameid, 0);
        assert.deepStrictEqual(session.callbacks, {});
        release.resolve();
        if (failure === 'timeout') {
            await waitUntil(() => !game.context.players.findPlayer(player1), 'timed-out entry cleanup');
            assert.equal(game.context.players.findClient(clientid), undefined);
            // A barrier waits for the late response to be processed before the next entry.
            assert.equal(await game.gate.asendCallbacke(MsgGameGateEnum.game2gate_info, game.id),
                game2gate_info_error.Game_already_registered);
            assert.deepStrictEqual(await c1.player.enterGame(game.id, player1), [ErrorEnum.ErrorOk]);
        }
    });
}
