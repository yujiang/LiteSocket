import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { LiteServer } from '../../src/net/LiteServer';
import { LiteServerClient } from '../../src/net/LiteServerClient';
import { LiteSocket } from '../../src/net/LiteSocket';
import type { LiteLogger } from '../../src/public/log';
import { connect, createClient, createLiteServer, waitUntil, within } from '../lite_test_helpers';

// 工厂直接创建连接子类；连接事件、全局消息和 clients 集合拿到的都是同一个对象。
test('connection factory creates the single client object used throughout the server', async context => {
    const created: CustomClient[] = [];
    class CustomClient extends LiteServerClient {
        readonly tag = 'custom';
        constructor(name: string, logger: LiteLogger, ws: WebSocket, owner: LiteServer, id: number, address = '') {
            super(name, logger, ws, owner, id, address);
            created.push(this);
        }
    }
    const connected: LiteServerClient[] = [];
    const messages: LiteServerClient[] = [];
    const server = new LiteServer('factory-test', console);
    server.setClientFactory(CustomClient);
    context.after(async () => {
        const websocketServer = server.wss;
        if (!websocketServer) return;
        const closed = once(websocketServer, 'close');
        for (const socket of server.clients.values()) socket.terminate();
        server.close();
        await within(closed, 'factory server cleanup');
    });
    server.onClient('client-connect', socket => connected.push(socket));
    server.onMessage('probe', socket => messages.push(socket));
    assert.deepStrictEqual(await server.listenPromise(0), [true]);
    const client = createClient(context);
    await connect(client, `ws://127.0.0.1:${server.port}`);
    client.emit('probe', 'hello');
    await waitUntil(() => messages.length === 1, 'factory message');
    assert.equal(created.length, 1);
    const socket = created[0];
    assert.equal(socket, connected[0]);
    assert.equal(socket, messages[0]);
    assert.equal(socket, server.clients.get(client.getServerId()));
    assert.equal(socket.server, server);
    assert.equal(socket.tag, 'custom');
    assert(socket.remoteAddress.endsWith('127.0.0.1'));
});

// 单连接 on 优先于服务器的同名全局处理；其他连接不受影响，未注册的消息仍走全局处理。
test('per-client handlers are isolated and take priority over server handlers', async context => {
    const { server, url } = await createLiteServer(context);
    const first = createClient(context);
    const second = createClient(context);
    await connect(first, url);
    await connect(second, url);
    const local: string[] = [];
    const global: Array<[number, string]> = [];
    server.onMessage('probe', (socket, data) => global.push([socket.id, data]));
    server.onMessage('fallback', (socket, data) => global.push([socket.id, data]));
    server.findById(first.getServerId()).on('probe', data => local.push(data));
    first.emit('probe', 'local');
    second.emit('probe', 'global');
    first.emit('fallback', 'fallback');
    await waitUntil(() => local.length === 1 && global.length === 2, 'local and global handlers');
    assert.deepStrictEqual(local, ['local']);
    assert.deepStrictEqual(global.find(entry => entry[0] === second.getServerId()), [second.getServerId(), 'global']);
    assert.deepStrictEqual(global.find(entry => entry[0] === first.getServerId()), [first.getServerId(), 'fallback']);
});

// 同一连接、同一消息仅保留最后注册的处理函数，on 返回当前连接以支持链式调用。
test('registering the same client message replaces its previous handler', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    await connect(client, url);
    const socket = server.findById(client.getServerId());
    const messages: string[] = [];
    socket.on('probe', () => messages.push('old'));
    assert.equal(socket.on('probe', () => messages.push('new')), socket);
    client.emit('probe', true);
    await waitUntil(() => messages.length === 1, 'replacement handler');
    assert.deepStrictEqual(messages, ['new']);
});

// dispose 令连接逻辑失效并停止消息分发；服务器关闭仍必须关闭真实 WebSocket，不能因逻辑失效而漏关。
test('disposed clients stop dispatching and server close still closes their transport', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    await connect(client, url);
    const socket = server.findById(client.getServerId());
    const messages: string[] = [];
    socket.on('probe', () => messages.push('local'));
    server.onMessage('fallback', () => messages.push('global'));
    socket.join('main');
    assert(server.getRoom('main').has(socket));
    assert(socket.dispose());
    assert.equal(socket.dispose(), false);
    assert.equal(socket.connected, false);
    assert.equal(socket.ws.readyState, WebSocket.OPEN);
    socket.ws.emit('message', Buffer.from(LiteSocket.encodeMessage('probe', true)));
    socket.ws.emit('message', Buffer.from(LiteSocket.encodeMessage('fallback', true)));
    assert.deepStrictEqual(messages, []);
    socket.join('ignored');
    assert.equal(server.getRoom('ignored'), undefined);
    server.close();
    assert.equal(server.clients.size, 0);
    assert.equal(server.getRoom('main'), undefined);
    await client.events.waitForCount('close', 1);
    assert.equal(socket.ws.readyState, WebSocket.CLOSED);
});

// 单连接 dispose 并非关闭传输的替代品；正常断线则自动释放处理器，且不能继续发送。
test('disconnect invalidates the client before notifying application handlers', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    await connect(client, url);
    const socket = server.findById(client.getServerId());
    let disconnected = false;
    server.onClient('client-disconnect', peer => {
        assert.equal(peer, socket);
        assert.equal(peer.connected, false);
        disconnected = true;
    });
    socket.ws.emit('error', new Error('connection lost'));
    assert(disconnected);
    assert.equal(socket.dispose(), false);
    socket.terminate();
    await client.events.waitForCount('close', 1);
});
