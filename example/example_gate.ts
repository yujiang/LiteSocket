import { strict as assert } from "node:assert";
import { createHeadLogger, createSliceLogger } from "../src/public/log";
import { setTimeout as delay } from 'node:timers/promises';

import {GameServer} from "../src/game/game/GameServer"
import {GateServer} from "../src/game/gate/GateServer"
import {GameClient} from "../src/game/client/GameClient"
import { ErrorEnum, setMsgNameFunc } from "../src/client";
import { getGameMsgName } from "../src/game/MsgGame";
import { chat_error, game2gate_info_error } from "../src/game/ErrorGame";

setMsgNameFunc(getGameMsgName);

async function run(){   
    const clientport = 2000
    const gateport = 100

    const loggame = createSliceLogger();
    const logclients = createSliceLogger();
    const loggames = createSliceLogger();
    const game = new GameServer(100, loggame, { checktimeout: true });
    const game2 = new GameServer(200, loggame, { checktimeout: true });
    const game3 = new GameServer(200, loggame, { checktimeout: true });

    const gate = new GateServer(10, logclients, loggames);

    const log1 = createSliceLogger();
    //const log1 = createHeadLogger("c1")
    const log2 = createSliceLogger();
    const log3 = createSliceLogger();
    const cc1 = new GameClient('client1', log1, { checktimeout: true });
    const c1 = cc1.player;
    const cc2 = new GameClient('client2', log2, { checktimeout: true });
    const c2 = cc2.player;
    const cc3 = new GameClient('client3', log3, { checktimeout: true });
    const c3 = cc3.player;

    const rt = await gate.start(gateport, {}, clientport, {});
    if (!rt[0]) throw new Error('gate.start failed');
    const rt1 = await game.start(`ws://127.0.0.1:${gateport}`);
    if (rt1 !== ErrorEnum.ErrorOk) throw new Error('game.start failed');
    const rt2 = await game2.start(`ws://127.0.0.1:${gateport}`);
    if (rt2 !== ErrorEnum.ErrorOk) throw new Error('game2.start failed');
    
    const rt3 = await game3.start(`ws://127.0.0.1:${gateport}`);
    // because game3 has the same id as game2, so it should fail to register with the gate
    if (rt3 === ErrorEnum.ErrorOk) throw new Error('game3.start succeeded but should have failed');
    assert(rt3 == game2gate_info_error.Game_already_registered);

    const [connected1] = await cc1.client.connectServer(`ws://127.0.0.1:${clientport}`, (reason, err) => {
        console.error('cc1客户端断线：', reason);
    });
    if (!connected1) throw new Error('客户端1连接失败');
    const [connected2] = await cc2.client.connectServer(`ws://127.0.0.1:${clientport}`, (reason, err) => {
        console.error('c2客户端断线：', reason);
    });
    if (!connected2) throw new Error('客户端2连接失败');

    const [connected3] = await cc3.client.connectServer(`ws://127.0.0.1:${clientport}`, (reason, err) => {
        console.error('c3客户端断线：', reason);
    });
    if (!connected3) throw new Error('客户端3连接失败');

    await c1.login();
    await c2.login();
    await c3.login();

    const player1 = 123;
    const player2 = 456;
    const player3 = 789;
    await c1.enterGame(game.id, player1);
    await c2.enterGame(game.id, player2);
    await c3.enterGame(game2.id, player3);

    const r0 = await c1.chatDes(0, 'hello 0');
    assert(r0 === chat_error.des_not_ingame)

    const r1 = await c1.chatDes(c2.playerid, 'hello ' + c2.playerid);
    //console.log('c1 chatDes c2:', r1);
    const r2 = await c2.bcChat('world!', "world");
    //console.log('c2 bcChat:', r2);
    const r3 = await c3.bcChat('games!', "games");
    //console.log('c3 bcChat:', r3);

    await c2.exit();
    assert (c2.playerid == 0);
    //const r2 = await c2.chat(c1.playerid, 'good job!');
    await c1.chatDes(player2, 'good job!');
    
    game.context.players.exitGame(player1, "test");
    await delay(1000);
    assert(!cc1.client.socket);

    process.exit(0);
}

run();
