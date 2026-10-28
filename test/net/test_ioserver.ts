// 测试 IOServer 在 LiteServer 上的业务消息分发、请求回调、连接生命周期和房间广播。

import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '../logger_helpers';
import { ErrorEnum } from '../../src/net/ErrorEnum';
import { getIp, IOServer } from '../../src/net/IOServer';
import { IOServerSocket } from '../../src/net/IOServerSocket';
import { LiteServerClient } from '../../src/net/LiteServerClient';
import { SocketParamEnum } from '../../src/net/msg';
import { MsgId, NetEventEnum } from '../../src/net/msgid';
import { connect, createClient, waitUntil, within } from '../lite_test_helpers';

const testMessage = 900001;

function createServer(context: TestContext) {
    const logger = createLogger({ silent: true });
    const errors: unknown[][] = [];
    context.mock.method(logger, 'error', (...args: unknown[]) => {
        errors.push(args);
        return logger;
    });
    const server = new IOServer('io-test', logger);
    context.after(() => {
        server.close();
        logger.close();
    });
    return { server, errors };
}

async function listen(server: IOServer) {
    assert.deepStrictEqual(await within(server.listen(0), 'IOServer listening'), [true]);
    return `ws://127.0.0.1:${server.io.port}`;
}

// 构造时即可注册处理函数；第一次连接就能分发连接消息及客户端业务消息，不依赖 socket.io 的 on。
test('handlers registered before listen process the first connection and business message', async context => {
    const { server, errors } = createServer(context);
    assert.equal(server.io, undefined);
    const connections: IOServerSocket[] = [];
    const messages: Array<[number, string]> = [];
    server.modHandle.register(MsgId.MSG_SYSTEM_CONNECT, (socket: IOServerSocket) => connections.push(socket),
        null, SocketParamEnum.rawSocket, 'connect-test');
    server.modHandle.register(testMessage, (socket: IOServerSocket, value: string) => messages.push([socket.id, value]),
        null, SocketParamEnum.rawSocket, 'message-test');
    const url = await listen(server);
    const client = createClient(context);
    await connect(client, url);
    client.emit(NetEventEnum.eventMod, [testMessage, 'hello']);
    await waitUntil(() => messages.length === 1, 'business message dispatched');
    assert.deepStrictEqual(messages, [[client.getServerId(), 'hello']]);
    assert.equal(connections.length, 1);
    const socket = connections[0];
    assert.equal(server.findById(socket.id), socket);
    assert.equal(socket, server.io.findById(socket.id));
    assert(socket instanceof LiteServerClient);
    assert.deepStrictEqual(Object.keys(server.io.msgHandlers), []);
    assert(socket.connected);
    assert.equal(socket.logger, server.logger);
    assert.equal(getIp(socket), '127.0.0.1');
    assert.deepStrictEqual(errors, []);
});

// cb 请求仍使用“消息 ID + 参数 + session”，同步或异步处理函数都通过 cb2 返回匹配的 session。
test('callback requests support synchronous and asynchronous business handlers', async context => {
    const { server, errors } = createServer(context);
    server.cbHandle.register(testMessage, (value: number) => [ErrorEnum.ErrorOk, value * 2],
        null, SocketParamEnum.noSocket, 'sync-callback');
    server.cbHandle.register(testMessage + 1, async (value: number) => [ErrorEnum.ErrorOk, value + 1],
        null, SocketParamEnum.noSocket, 'async-callback');
    const url = await listen(server);
    const client = createClient(context);
    const replies: unknown[] = [];
    client.on(NetEventEnum.eventCallbacked, data => replies.push(data));
    await connect(client, url);
    client.emit(NetEventEnum.eventCallback, [testMessage, 5, 101]);
    client.emit(NetEventEnum.eventCallback, [testMessage + 1, 8, 102]);
    await waitUntil(() => replies.length === 2, 'callback replies');
    assert.deepStrictEqual(replies, [[101, [ErrorEnum.ErrorOk, 10]], [102, [ErrorEnum.ErrorOk, 9]]]);
    assert.deepStrictEqual(errors, []);
});

// 慢回调的 profile logger 未初始化时，日志诊断不能把成功结果改成 Callback_await_error。
test('slow callback returns its result when the profile logger is not initialized', async context => {
    const { server, errors } = createServer(context);
    server.cbHandle.register(testMessage, async (value: number) => {
        await delay(1100);
        return [ErrorEnum.ErrorOk, value + 5];
    }, null, SocketParamEnum.noSocket, 'slow-callback');
    const url = await listen(server);
    const client = createClient(context);
    const response = new Promise<unknown>(resolve => client.on(NetEventEnum.eventCallbacked, resolve));
    await connect(client, url);
    client.emit(NetEventEnum.eventCallback, [testMessage, 3, 1]);
    assert.deepStrictEqual(await within(response, 'slow callback result'), [1, [ErrorEnum.ErrorOk, 8]]);
    assert.deepStrictEqual(errors, []);
});

// 原有查询服务器名字的内置消息继续保留，但返回值遵循现有回调框架的“错误码在首位”约定。
test('built-in server query returns valid callback results', async context => {
    const { server, errors } = createServer(context);
    const url = await listen(server);
    const client = createClient(context);
    const replies: unknown[] = [];
    client.on(NetEventEnum.eventCallbacked, data => replies.push(data));
    await connect(client, url);
    client.emit(NetEventEnum.eventCallback, [MsgId.MSG_SYSTEM_QUERYHTTPSERVER, 'name', 201]);
    client.emit(NetEventEnum.eventCallback, [MsgId.MSG_SYSTEM_QUERYHTTPSERVER, 'missing', 202]);
    await waitUntil(() => replies.length === 2, 'server query replies');
    assert.deepStrictEqual(replies, [
        [201, [ErrorEnum.ErrorOk, 'io-test']],
        [202, [ErrorEnum.ErrorError, 'unknown key missing']],
    ]);
    assert.deepStrictEqual(errors, []);
});

// 两个客户端的 SockWrap 都从 session=1 开始；cb2 必须按连接隔离，不能把另一个客户端的请求结束。
test('server-to-client callbacks are isolated per connection', async context => {
    const { server, errors } = createServer(context);
    const url = await listen(server);
    const clients = [createClient(context), createClient(context)];
    for (const [index, client] of clients.entries()) {
        client.on(NetEventEnum.eventCallback, data => {
            const session = data[data.length - 1];
            client.emit(NetEventEnum.eventCallbacked, [session, [ErrorEnum.ErrorOk, index]]);
        });
        await connect(client, url);
    }
    const sockets = clients.map(client => server.findById(client.getServerId()));
    const results = await within(Promise.all(sockets.map(socket =>
        socket.cb.asendSession(NetEventEnum.eventCallback, [testMessage], 1000))), 'server callback results');
    assert.deepStrictEqual(results, [[ErrorEnum.ErrorOk, 0], [ErrorEnum.ErrorOk, 1]]);
    for (const socket of sockets) assert.deepStrictEqual(Object.keys(socket.cb.callbacks), []);
    assert.deepStrictEqual(errors, []);
});

// 被动断开后，业务的断线消息只派发一次，未完成的服务端请求以 Callback_disconnect 结束并移除记录。
test('disconnect dispatches one lifecycle message and settles pending callbacks', async context => {
    const { server } = createServer(context);
    const disconnected: IOServerSocket[] = [];
    server.modHandle.register(MsgId.MSG_SYSTEM_DISCONNECT, (socket: IOServerSocket) => disconnected.push(socket),
        null, SocketParamEnum.rawSocket, 'disconnect-test');
    const url = await listen(server);
    const client = createClient(context);
    let received = false;
    client.on(NetEventEnum.eventCallback, () => { received = true; });
    await connect(client, url);
    const socket = server.findById(client.getServerId());
    const pending = socket.cb.asendSession(NetEventEnum.eventCallback, [testMessage], 1000);
    await waitUntil(() => received, 'pending server request');
    client.disconnect();
    const result = await within(pending, 'pending callback cancelled by disconnect');
    await client.events.waitForCount('close', 1);
    await waitUntil(() => server.io.clients.size === 0 && server.io.clientsNum() === 0, 'connection cleaned');
    assert.equal(result[0], ErrorEnum.Callback_disconnect);
    assert.deepStrictEqual(disconnected, [socket]);
    assert(!socket.connected);
    assert.deepStrictEqual(Object.keys(socket.cb.callbacks), []);
});

// socket.join/leave 映射到 LiteServer 房间；bc 只发送给当前成员，不给离开者或房间外的客户端。
test('room broadcast uses LiteServer membership', async context => {
    const { server } = createServer(context);
    const url = await listen(server);
    const clients = [createClient(context), createClient(context), createClient(context)];
    const messages: unknown[][] = clients.map(() => []);
    const barriers: boolean[] = clients.map(() => false);
    for (const [index, client] of clients.entries()) {
        client.on(NetEventEnum.eventBc, data => messages[index].push(data));
        client.on('barrier', () => { barriers[index] = true; });
        await connect(client, url);
    }
    const first = server.findById(clients[0].getServerId());
    const second = server.findById(clients[1].getServerId());
    first.join('main');
    second.join('main');
    server.bc('main', [testMessage, 'both']);
    second.leave('main');
    server.bc('main', [testMessage, 'first-only']);
    assert.doesNotThrow(() => server.bc('missing', [testMessage]));
    server.io.broadcast('barrier', true);
    await waitUntil(() => barriers.every(Boolean), 'room broadcast barriers');
    assert.deepStrictEqual(messages, [
        [[testMessage, 'both'], [testMessage, 'first-only']],
        [[testMessage, 'both']],
        [],
    ]);
});

// 服务器主动关闭也要完成业务断线清理；LiteServer.close 清空事件后，不应留下悬挂的回调请求。
test('server close settles callbacks and cleans each business socket once', async context => {
    const { server } = createServer(context);
    const disconnected: IOServerSocket[] = [];
    server.modHandle.register(MsgId.MSG_SYSTEM_DISCONNECT, (socket: IOServerSocket) => disconnected.push(socket),
        null, SocketParamEnum.rawSocket, 'shutdown-test');
    const url = await listen(server);
    const client = createClient(context);
    client.on(NetEventEnum.eventCallback, () => {});
    await connect(client, url);
    const socket = server.findById(client.getServerId());
    const pending = socket.cb.asendSession(NetEventEnum.eventCallback, [testMessage], 1000);
    const transport = server.io;
    server.close();
    assert.equal((await within(pending, 'shutdown callback cancellation'))[0], ErrorEnum.Callback_disconnect);
    await client.events.waitForCount('close', 1);
    assert.equal(transport.clients.size, 0);
    assert.deepStrictEqual(disconnected, [socket]);
    assert(!socket.connected);
    assert.doesNotThrow(() => server.close());
});

// 每次监听只配置一次新服务器；重新监听保留业务处理函数，且每条连接只派发一次连接消息。
test('relisten preserves handlers and does not duplicate connection setup', async context => {
    const { server, errors } = createServer(context);
    const messages: string[] = [];
    let connections = 0;
    server.modHandle.register(MsgId.MSG_SYSTEM_CONNECT, () => { connections++; },
        null, SocketParamEnum.noSocket, 'relisten-connect');
    server.modHandle.register(testMessage, (value: string) => messages.push(value),
        null, SocketParamEnum.noSocket, 'relisten-test');
    const handle = server.handle;
    await listen(server);
    const url = await listen(server);
    assert.equal(server.handle, handle);
    const client = createClient(context);
    await connect(client, url);
    client.emit(NetEventEnum.eventMod, [testMessage, 'preserved']);
    await waitUntil(() => messages.length === 1, 'preserved handler');
    assert.deepStrictEqual(messages, ['preserved']);
    assert.equal(connections, 1);
    assert.equal(server.io.clients.size, 1);
    assert.deepStrictEqual(errors, []);
});

// 客户端协议异常走 onClient，广播异常走 onEvent，两条路径都应进入 IOServer 的日志。
// 用后续正常业务消息确认协议异常已处理，且不会阻断原有消息分发。
test('client and broadcast exceptions are forwarded to the server logger', async context => {
    const { server, errors } = createServer(context);
    const messages: string[] = [];
    server.modHandle.register(testMessage, (value: string) => messages.push(value),
        null, SocketParamEnum.noSocket, 'exception-test');
    assert.deepStrictEqual(await server.listen(0, { maxSendLen: 256, maxRecvLen: 128 }), [true]);
    const client = createClient(context);
    await connect(client, `ws://127.0.0.1:${server.io.port}`);
    client.wsSend('{invalid JSON');
    client.emit(NetEventEnum.eventMod, [testMessage, 'still connected']);
    await waitUntil(() => messages.length === 1, 'business message after protocol exception');
    server.findById(client.getServerId()).join('main');
    server.bc('main', [testMessage, 'x'.repeat(256)]);
    assert.equal(errors.length, 3);
    assert(String(errors[0][0]).includes('parseMessage'));
    assert.equal(errors[1][0], 'IOServer client exception');
    assert.equal(errors[2][0], 'IOServer broadcast exception');
    assert.deepStrictEqual(messages, ['still connected']);
    assert(client.isConnected());
});

// 服务端 socket 先报 error 再关闭时，也只派发一次业务断线消息并记录错误，不能留下旧适配对象。
test('socket error followed by close cleans business state exactly once', async context => {
    const { server, errors } = createServer(context);
    const disconnected: IOServerSocket[] = [];
    server.modHandle.register(MsgId.MSG_SYSTEM_DISCONNECT, (socket: IOServerSocket) => disconnected.push(socket),
        null, SocketParamEnum.rawSocket, 'socket-error-test');
    const url = await listen(server);
    const client = createClient(context);
    await connect(client, url);
    const socket = server.findById(client.getServerId());
    socket.ws.emit('error', new Error('server socket failure'));
    assert.deepStrictEqual(disconnected, [socket]);
    assert(!socket.connected);
    socket.terminate();
    await client.events.waitForCount('close', 1);
    await waitUntil(() => server.io.clientsNum() === 0, 'errored socket closed');
    assert.equal(server.io.clients.size, 0);
    assert.deepStrictEqual(disconnected, [socket]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], 'IOServer client error');
});
