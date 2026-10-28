import { createSliceLogger } from "../src/public/log";

import {GameServer} from "../src/game/GameServer"
import {GateServer} from "../src/game/GateServer"
import {GameClient} from "../src/game/GameClient"

async function run(){
    const clientport = 2000
    const gateport = 100

    const loggame = createSliceLogger();
    const logclients = createSliceLogger();
    const loggames = createSliceLogger();
    const game = new GameServer(100, loggame, { checktimeout: true });
    const gate = new GateServer(10, logclients, loggames);

    const log1 = createSliceLogger();
    const log2 = createSliceLogger();
    const c1 = new GameClient('client1', log1, { checktimeout: true });
    const c2 = new GameClient('client2', log2, { checktimeout: true });

    const rt = await gate.start(gateport, {}, clientport, {});
    if (!rt[0]) throw new Error('gate.start failed');
    const rt2 = await game.start(`ws://127.0.0.1:${gateport}`);
    if (!rt2) throw new Error('game.start failed');

    const connected1 = await c1.connectServer(`ws://127.0.0.1:${clientport}`, (reason, err) => {
        console.error('客户端断线：', reason, err);
    });
    if (!connected1) throw new Error('客户端1连接失败');
    const connected2 = await c2.connectServer(`ws://127.0.0.1:${clientport}`, (reason, err) => {
        console.error('客户端断线：', reason, err);
    });
    if (!connected2) throw new Error('客户端1连接失败');

    await c1.login();
    await c2.login();
    const player1 = 123;
    const player2 = 456;
    await c1.enterGame(game.id, player1);
    await c2.enterGame(game.id, player2);
    const r1 = await c1.chat(c2.playerid, 'hello world');
    await c2.exit();
    //const r2 = await c2.chat(c1.playerid, 'good job!');
    await c1.chat(player2, 'good job!');
    process.exit(0);
}

run();
