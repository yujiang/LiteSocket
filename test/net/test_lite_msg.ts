// 对于ioserver, ioclient 传递消息
// 1. 基础消息
// 2. 异步消息
// 3. 异步消息超时
// 运行：pnpm test:build 后执行 node .test-build/test/net/test_lite_msg.js

import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '../logger_helpers';
import { IOClient } from '../../src/net/IOClient';
import { IOServer } from '../../src/net/IOServer';
import type { IOServerSocket } from '../../src/net/IOServerSocket';
import { NetEventEnum } from '../../src/net/msgid';
import { ErrorEnum, FirstErrorRt } from '../../src/net/ErrorEnum';

const helloMessage = 900001;
const helloReplyMessage = 900002;
const addMessage = 900003;
const timeoutMessage = 900004;

async function example() {
    const logger = createLogger({ silent: true });
    const server = new IOServer('example-server', logger);
    const client = new IOClient('example-client', logger, { checktimeout: true, checkIntervalMs: 1000 }, {});

    // 普通消息：客户端发送 helloMessage，服务器使用另一个消息 ID 回复。
    server.onMessage(helloMessage, (socket: IOServerSocket, name: string) => {
        console.log('服务器收到普通消息：', name);
        socket.emitMod(helloReplyMessage, `你好，${name}！`);
    });
    const helloReply = new Promise<void>(resolve => {
        client.onMessage(helloReplyMessage, (message: string) => {
            console.log('客户端收到回复：', message);
            resolve();
        });
    });

    // 异步请求：服务端处理函数返回 Promise，框架将结果送回客户端对应的 asend。
    server.onCallback(addMessage, async (socket: IOServerSocket, left: number, right: number) => {
        console.log(`服务器处理连接 ${socket.id} 的异步请求：`, left, right);
        await delay(100);
        return [ErrorEnum.ErrorOk, left + right];
    });

    // 仅用于演示超时：模拟业务一直等待外部任务，故意不完成，不创建额外定时器。
    server.onCallback(timeoutMessage, () => new Promise<FirstErrorRt>(() => {}));

    try {
        // 注册完成后再监听；端口 0 自动选择空闲端口，连接成功即可发送消息。
        const [listening, error] = await server.listen('example-server', 0);
        if (!listening) throw error;
        const connected = await client.connectServer(`ws://127.0.0.1:${server.io.port}`, (reason, err) => {
            console.error('客户端断线：', reason, err);
        });
        if (!connected) throw new Error('客户端连接失败');

        console.log('\n1. 基础消息');
        client.send([helloMessage, 'Lite']);
        await helloReply;

        console.log('\n2. 异步消息');
        const [code, sum] = await client.asend([addMessage, 3, 5], 3000);
        if (code !== ErrorEnum.ErrorOk || sum !== 8) throw new Error(`异步请求结果不符合预期：${code}, ${sum}`);
        console.log('客户端 await asend 得到结果：', sum);

        console.log('\n3. 异步消息超时（检查周期为 1 秒，请稍候）');
        const started = Date.now();
        const [timeoutCode] = await client.asend([timeoutMessage], 1000);
        if (timeoutCode !== ErrorEnum.Callback_timeout) throw new Error(`预期超时，实际错误码：${timeoutCode}`);
        console.log(`客户端收到 Callback_timeout，实际等待 ${Date.now() - started}ms`);
        console.log('超时参数是 1000ms，但需等到下一次轮询检查才会返回。');
    } finally {
        client.destroy('example finished');
        server.close();
        logger.close();
    }
}

example().catch(error => {
    console.error('示例执行失败：', error);
    process.exitCode = 1;
});
