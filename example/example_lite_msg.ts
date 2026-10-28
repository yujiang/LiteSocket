// 运行：pnpm example
import { strict as assert } from "node:assert";
import { setTimeout as delay } from 'node:timers/promises';
import { IOClient } from '../src/net/IOClient';
import { IOServer } from '../src/net/IOServer';
import type { IOServerSocket } from '../src/net/IOServerSocket';
import { setMsgNameFunc } from '../src/net/msgid';
import { ErrorEnum } from '../src/net/ErrorEnum';
import { createHeadLogger, createSliceLogger } from '../src/public/log';

enum myMsg {
 s2c_helloMessage = 900001,
 c2s_helloReplyMessage,
 c2s_rpc_addMessage ,
 s2c_rpc_mulMessage ,
}

export function getMsgName(id: number): string {
    // console.log('getMsgName:', id);
    return myMsg[id];
}

setMsgNameFunc(getMsgName);

async function example() {
    const logger = createSliceLogger();
    const logs = createHeadLogger('server')
    const logc = createHeadLogger('client')
    const server = new IOServer('example-server', logs);
    const client = new IOClient('example-client', logc, { checktimeout: true });

    // 普通消息：服务端收到 helloMessage，使用另一个消息 ID 返回结果。
    server.onMessage(myMsg.s2c_helloMessage, (socket: IOServerSocket, name: string) => {
        console.log('服务端收到普通消息：', name);
        socket.sendMsg(myMsg.c2s_helloReplyMessage, `你好，${name}！`);
    });

    const helloReply = new Promise<void>(resolve => {
        client.onMessage(myMsg.c2s_helloReplyMessage, (message: string) => {
            console.log('客户端收到另一个消息：', message);
            resolve();
        });
    });

    // RPC 消息：处理函数直接返回“错误码 + 结果”，框架自动关联客户端的 Promise。
    server.onCallback(myMsg.c2s_rpc_addMessage, (socket: IOServerSocket, left: number, right: number) => {
        console.log('服务端收到 c2s_rpc_addMessage', left, right);
        return [ErrorEnum.ErrorOk, left + right];
    });

    // RPC 返回业务数据时，应返回 [错误码, 结果]；单独返回 number 会被当作错误码。
    client.onCallback(myMsg.s2c_rpc_mulMessage, async (left: number, right: number) => {
        console.log('客户端收到 s2c_rpc_mulMessage', left, right);
        await delay(1000);
        return [ErrorEnum.ErrorOk, left * right];
    });    

    try {
        // 先注册消息，再监听和连接；端口 0 表示自动分配空闲端口。
        const [listening, error] = await server.listen(0);
        if (!listening) throw error;

        const connected = await client.connectServer(`ws://127.0.0.1:${server.io.port}`, (reason, err) => {
            console.error('客户端断线：', reason, err);
        });
        if (!connected) throw new Error('客户端连接失败');

        const connectid = client.socket.getServerId();
        server.io.observe(connectid, console);

        client.sendMsg(myMsg.s2c_helloMessage, 'Lite');
        await helloReply;

        // asend 不需要注册返回消息，直接 await 获取服务端返回的结果。
        const [code, sum] = await client.asendMsg(myMsg.c2s_rpc_addMessage, 3, 5);
        if (code !== ErrorEnum.ErrorOk || sum !== 8) throw new Error(`RPC 失败：${code}`);
        console.log('客户端 await asend c2s_rpc_addMessage 得到结果：', sum);

        const sc = server.findById(connectid);
        assert(sc);
        const [code2, sum2] = await sc.asendMsg(myMsg.s2c_rpc_mulMessage, 3, 5);
        if (code2 !== ErrorEnum.ErrorOk || sum2 !== 15) {
            throw new Error(`RPC2 结果不符合预期：${sum2}`);
        }
        console.log('客户端 await asend s2c_rpc_mulMessage 得到结果：', sum2);
    } finally {
        client.destroy('example finished');
        server.close();
    }
}

example().catch(error => {
    console.error('示例执行失败：', error);
    process.exitCode = 1;
});
