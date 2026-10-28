// 使用net/lite模块, 测试连接成功、连接失败、手动重连和断开连接

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { test, TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { LiteServerClient } from '../../src/net/LiteServerClient';
import { getWsUrl, SocketCloseCode } from '../../src/net/LiteNet';
import {
    connect, createClient, createLiteServer, createStalledServer,
    LiteServerTest, LiteClientTest, unusedAddress, waitUntil, within,
} from '../lite_test_helpers';

// connected getter 与 isConnected 一致：只有收到 system 才就绪，断线和销毁后立即为 false。
test('connected getter follows protocol readiness and disconnect state', async context => {
    const { server, url } = await createSystemServer(context);
    const client = createClient(context);
    assert.equal(client.connected, false);
    const accepted = once(server, 'connection');
    const connecting = client.connectPromise(url);
    const [socket] = await within(accepted, 'accepted before system');
    await waitUntil(() => client.ws.readyState === WebSocket.OPEN, 'transport open');
    assert.equal(client.connected, false);
    socket.send(JSON.stringify({ eventName: 'system', data: {
        id: 7, maxSendLen: 1024, maxRecvLen: 1024,
    } }));
    assert.deepStrictEqual(await within(connecting, 'protocol ready'), [true, '']);
    assert.equal(client.connected, true);
    assert.equal(client.connected, client.isConnected());
    socket.terminate();
    await client.events.waitForCount('disconnect', 1);
    assert.equal(client.connected, false);
    client.destroy();
    assert.equal(client.connected, false);
});

// 只完成 WebSocket 握手、不自动发送 system，供测试主动控制协议初始化的时机。
async function createSystemServer(context: TestContext) {
    const server = new WebSocketServer({ port: 0 });
    context.after(async () => {
        const closed = once(server, 'close');
        for (const socket of server.clients) socket.terminate();
        server.close();
        await within(closed, 'system server cleanup');
    });
    await within(once(server, 'listening'), 'system server listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    return { server, url: getWsUrl('127.0.0.1', address.port) };
}

// 执行一次断开操作，等客户端和服务端都关闭后，统一检查事件顺序、关闭原因和连接清理。
// close 计数取“当前次数 + 1”，因此同一个客户端断开后重连，也可以复用此检查。
async function disconnectAndCheck(
    server: LiteServerTest,
    client: LiteClientTest,
    action: (peer: LiteServerClient) => void,
    code: number,
    reason: string,
) {
    const peer = server.findById(client.getServerId());
    assert(peer);
    const clientCloseCount = client.events.count('close') + 1;
    const serverCloseCount = server.events.count('client-close') + 1;
    action(peer);
    await Promise.all([
        client.events.waitForCount('close', clientCloseCount),
        server.events.waitForCount('client-close', serverCloseCount),
    ]);
    assert(!client.isConnected());
    assert(!client.isConnecting());
    assert.equal(client.timeoutHandle, null);
    assert.equal(server.findById(peer.id), undefined);
    assert.deepStrictEqual(client.events.names().slice(-2), ['disconnect', 'close']);
    assert.equal(client.events.count('disconnect'), clientCloseCount);
    assert.equal(client.events.count('connect_fail'), 0);
    assert.equal(client.events.count('error'), 0);
    const disconnected = client.events.entries.filter(entry => entry.event === 'disconnect').slice(-1)[0];
    assert.equal(disconnected.reason, 'close');
    assert.equal(disconnected.err.code, code);
    assert.equal(disconnected.err.reason, reason);
    const peerEvents = server.events.entries.filter(entry => entry.clientId === peer.id);
    assert.deepStrictEqual(peerEvents.map(entry => entry.event), [
        'client-connect', 'client-disconnect', 'client-close',
    ]);
    assert.equal(peerEvents[1].reason, 'close');
    assert.deepStrictEqual(peerEvents[1].err, { code, reason });
}

// 空地址直接返回失败；不能创建 WebSocket、启动连接，也不应触发任何连接事件。
test('empty URL does not start a connection', async context => {
    const client = createClient(context);
    assert.equal(client.connect(''), false);
    assert.deepStrictEqual(await client.connectPromise(''), [false, 'empty url']);
    assert.equal(client.ws, undefined);
    assert(!client.isConnected());
    assert(!client.isConnecting());
    assert.deepStrictEqual(client.events.names(), []);
});

// WebSocket 已打开但尚未收到 system 时，客户端仍处于连接中；重复调用共享原 Promise。
// system 到达后才触发 connect、返回成功，此时服务端 ID 和收发限制必须已经可用。
test('connectPromise waits for system and exposes initialized state immediately', async context => {
    const { server, url } = await createSystemServer(context);
    const client = createClient(context);
    const accepted = once(server, 'connection');
    const first = client.connectPromise(url);
    let settled = false;
    void first.then(() => { settled = true; });
    const [socket] = await within(accepted, 'WebSocket open without system');
    await waitUntil(() => client.ws.readyState === WebSocket.OPEN, 'client WebSocket open');
    assert(!client.isConnected());
    assert(client.isConnecting());
    assert(client.timeoutHandle);
    const second = client.connectPromise(url);
    assert.equal(first, second);
    assert.equal(client.connect(url), true);
    await delay(25);
    assert.equal(settled, false);
    assert.deepStrictEqual(client.events.names(), []);
    const sys = { id: 7, maxSendLen: 128, maxRecvLen: 512 };
    let stateAtConnect: typeof sys;
    client.onEvent('connect', () => { stateAtConnect = client.getSys(); });
    socket.send(JSON.stringify({ eventName: 'system', data: sys }));
    assert.deepStrictEqual(await within(first, 'system initializes connection'), [true, '']);
    assert.deepStrictEqual(await second, [true, '']);
    assert.deepStrictEqual(stateAtConnect, sys);
    assert.deepStrictEqual(client.getSys(), sys);
    assert.equal(client.getServerId(), 7);
    assert.equal(client.getMaxSendLen(), 128);
    assert.equal(client.getMaxRecvLen(), 512);
    assert(client.isConnected());
    assert(!client.isConnecting());
    assert.equal(client.timeoutHandle, null);
    const received = once(socket, 'message');
    client.emit('probe', 'ready');
    const [data] = await within(received, 'send immediately after connectPromise');
    assert.deepStrictEqual(JSON.parse(data.toString()), { eventName: 'probe', data: 'ready' });
    // 重复 system 不能重复发 connect，也不能覆盖首次初始化的配置；用后续消息确认已处理完。
    let checked = false;
    client.on('checked', () => { checked = true; });
    socket.send(JSON.stringify({ eventName: 'system', data: { id: 99, maxSendLen: 1, maxRecvLen: 1 } }));
    socket.send(JSON.stringify({ eventName: 'checked' }));
    await waitUntil(() => checked, 'duplicate system handled');
    assert.deepStrictEqual(client.events.names(), ['connect']);
    assert.deepStrictEqual(client.getSys(), sys);
});

// 只握手、不发 system 的服务器不能让 Promise 永久等待，初始化仍受同一个连接超时限制。
// 超时后不应触发 connect/disconnect，迟到的 system 也不能把失败的连接重新标成成功。
test('missing system times out after WebSocket opens', async context => {
    const { server, url } = await createSystemServer(context);
    const client = createClient(context);
    const accepted = once(server, 'connection');
    const result = client.connectPromise(url, 150);
    await within(accepted, 'WebSocket accepted before system timeout');
    const onMessage = client.ws.onmessage;
    assert.deepStrictEqual(await within(result, 'missing system timeout'), [false, 'timeout']);
    await client.events.waitForCount('close', 1);
    onMessage.call(client.ws, {
        type: 'message',
        target: client.ws,
        data: JSON.stringify({ eventName: 'system', data: {
            id: 9, maxSendLen: 1024, maxRecvLen: 1024,
        } }),
    });
    assert.deepStrictEqual(client.events.names(), ['connect_fail', 'close']);
    assert.equal(client.getSys(), undefined);
    assert.equal(client.getServerId(), 0);
    assert(!client.isConnected());
    assert(!client.isConnecting());
    assert.equal(client.timeoutHandle, null);
});

for (const closer of ['client', 'server', 'terminate'] as const) {
    // 在 system 到达前主动取消、服务端关闭或强制断开，都属于连接失败，而不是已连接后的断线。
    test(`${closer} closes before system and settles connectPromise as failure`, async context => {
        const { server, url } = await createSystemServer(context);
        const client = createClient(context);
        const accepted = once(server, 'connection');
        const result = client.connectPromise(url);
        const [socket] = await within(accepted, 'WebSocket accepted before close');
        await waitUntil(() => client.ws.readyState === WebSocket.OPEN, 'client open before close');
        if (closer === 'client') client.disconnect();
        else if (closer === 'server') socket.close(SocketCloseCode.test, 'before system');
        else socket.terminate();
        assert.deepStrictEqual(await within(result, 'closed before system'), [false, 'close']);
        await client.events.waitForCount('close', 1);
        assert.deepStrictEqual(client.events.names(), ['connect_fail', 'close']);
        assert.equal(client.getSys(), undefined);
        assert.equal(client.timeoutHandle, null);
        assert(!client.isConnected());
    });
}

// 原地址已握手但仍在等待 system 时切换地址，旧请求返回 superseded，新请求完成全部初始化。
// 旧 system 即使随后回调，也不能修改新连接的状态。
test('switching URLs while waiting for system cancels the old initialization', async context => {
    const old = await createSystemServer(context);
    const replacement = await createLiteServer(context);
    const client = createClient(context);
    const accepted = once(old.server, 'connection');
    const first = client.connectPromise(old.url);
    await within(accepted, 'old connection waiting for system');
    const oldSocket = client.ws;
    const oldMessage = oldSocket.onmessage;
    const second = client.connectPromise(replacement.url);
    oldMessage.call(oldSocket, {
        type: 'message',
        target: oldSocket,
        data: JSON.stringify({ eventName: 'system', data: {
            id: 999, maxSendLen: 1, maxRecvLen: 1,
        } }),
    });
    assert.deepStrictEqual(await within(first, 'superseded initialization'), [false, 'superseded']);
    assert.deepStrictEqual(await within(second, 'replacement initialization'), [true, '']);
    assert.equal(client.getServerId(), 1);
    assert.equal(client.getMaxSendLen(), replacement.server.opts.maxRecvLen);
    assert.equal(client.getMaxRecvLen(), replacement.server.opts.maxSendLen);
    assert.deepStrictEqual(client.events.names(), ['connect']);
});

// 两个客户端连接同一服务器，分别获得不同的服务端 ID。
// 对其中一个客户端连续调用两次 disconnect，只断开一次，且不能影响另一个客户端。
test('two clients connect independently and repeated disconnect is harmless', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    const other = createClient(context);
    await connect(client, url);
    await connect(other, url);
    assert.equal(server.clientsNum(), 2);
    assert.notEqual(client.getServerId(), other.getServerId());
    await disconnectAndCheck(server, client, () => {
        client.disconnect(SocketCloseCode.test, 'client disconnect');
        client.disconnect(SocketCloseCode.test, 'client disconnect');
    }, SocketCloseCode.test, 'client disconnect');
    assert(other.isConnected());
    assert.deepStrictEqual(other.events.names(), ['connect']);
    assert.equal(server.clientsNum(), 1);
    await disconnectAndCheck(server, other, () => other.disconnect(), SocketCloseCode.disconnect, '');
    assert.equal(server.clientsNum(), 0);
});

// 连接中重复连接同一 URL，应复用 socket，并让两个 Promise 一起等待真实的连接结果。
// 已经连接成功后再调用，则立即返回 same url；整个过程只产生一次 connect。
test('same URL while connecting or connected reuses the socket', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    const first = client.connectPromise(url);
    const socket = client.ws;
    assert(client.isConnecting());
    assert.equal(client.connect(url), true);
    const second = client.connectPromise(url);
    assert.equal(client.ws, socket);
    assert.deepStrictEqual(await within(Promise.all([first, second]), 'shared connection'), [[true, ''], [true, '']]);
    assert.deepStrictEqual(await client.connectPromise(url), [true, 'same url']);
    assert.equal(client.connect(url), true);
    assert.equal(client.ws, socket);
    assert.deepStrictEqual(client.events.names(), ['connect']);
    assert.equal(server.events.count('client-connect'), 1);
    assert.equal(server.clientsNum(), 1);
});

for (const useArgument of [false, true]) {
    // 循环生成两个测试：一个使用构造选项中的 250ms，另一个用调用参数把 5000ms 覆盖为 250ms。
    // 模拟服务只接收 TCP、不完成 WebSocket 握手，验证实际超时耗时及失败后清理。
    test(`handshake timeout uses ${useArgument ? 'call argument' : 'constructor option'}`, async context => {
        const { url } = await createStalledServer(context);
        const client = createClient(context, { connectTimeout: useArgument ? 5000 : 250 });
        const started = performance.now();
        const result = await within(
            useArgument ? client.connectPromise(url, 250) : client.connectPromise(url),
            'handshake timeout',
        );
        const elapsed = performance.now() - started;
        assert.deepStrictEqual(result, [false, 'timeout']);
        // 给系统调度留出余量，同时防止实现意外使用默认的 5000ms。
        assert(elapsed >= 225 && elapsed < 2000, `timeout elapsed ${elapsed}ms`);
        await client.events.waitForCount('close', 1);
        assert.deepStrictEqual(client.events.names(), ['connect_fail', 'error', 'close']);
        assert.equal(client.events.entries[0].reason, 'timeout');
        assert(!client.isConnected());
        assert(!client.isConnecting());
        assert.equal(client.timeoutHandle, null);
    });
}

// 不返回 Promise 的 connect() 也必须遵守构造选项中的超时。
// 握手从未成功，因此只产生 connect_fail，不能误报已连接后的 disconnect。
test('connect() also honors the configured handshake timeout', async context => {
    const { url } = await createStalledServer(context);
    const client = createClient(context, { connectTimeout: 250 });
    const started = performance.now();
    assert.equal(client.connect(url), true);
    await client.events.waitForCount('close', 1);
    const elapsed = performance.now() - started;
    assert(elapsed >= 225 && elapsed < 2000, `timeout elapsed ${elapsed}ms`);
    assert.equal(client.events.count('connect_fail'), 1);
    assert.equal(client.events.entries[0].reason, 'timeout');
    assert.equal(client.events.count('disconnect'), 0);
});

// 同时两次连接无人监听的端口，两个调用者都应收到 error，而非第二个提前报告成功。
// 虽然有两个 Promise，但实际只有一个 socket、一次 connect_fail 和一次 close。
test('concurrent same URL callers share the connection failure', async context => {
    const { url } = await unusedAddress(context);
    const client = createClient(context);
    const first = client.connectPromise(url);
    const socket = client.ws;
    const reused = client.connectPromise(url);
    assert.deepStrictEqual(await within(Promise.all([first, reused]), 'refused connection'), [
        [false, 'error'], [false, 'error'],
    ]);
    await client.events.waitForCount('close', 1);
    assert.equal(client.ws, socket);
    assert.deepStrictEqual(client.events.names(), ['connect_fail', 'error', 'close']);
    assert.equal(client.events.entries[0].reason, 'error');
    assert(!client.isConnected());
    assert(!client.isConnecting());
    assert.equal(client.timeoutHandle, null);
});

// 第二次连接同一 URL 时，先等 25ms，确认它没有提前返回成功。
// 直到首次连接在 250ms 后超时，两个 Promise 才一起返回 timeout。
test('same URL callers remain pending until the handshake times out', async context => {
    const { url } = await createStalledServer(context);
    const client = createClient(context);
    const first = client.connectPromise(url, 250);
    let settled = false;
    const second = client.connectPromise(url).then(result => {
        settled = true;
        return result;
    });
    await delay(25);
    assert.equal(settled, false);
    assert.deepStrictEqual(await within(Promise.all([first, second]), 'shared timeout'), [
        [false, 'timeout'], [false, 'timeout'],
    ]);
});

// 旧地址的握手尚未结束就改连新地址：旧 Promise 返回 superseded，新连接正常成功。
// 人工调用旧 socket 保存下来的回调，模拟迟到事件，验证它们不能改写新连接的状态或系统信息。
test('switching URLs cancels the previous attempt and ignores its late callbacks', async context => {
    const stalled = await createStalledServer(context);
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    const first = client.connectPromise(stalled.url, 1000);
    await waitUntil(() => stalled.sockets.size === 1, 'old TCP connection');
    const oldSocket = client.ws;
    const onOpen = oldSocket.onopen;
    const onError = oldSocket.onerror;
    const onClose = oldSocket.onclose;
    const onMessage = oldSocket.onmessage;
    const second = client.connectPromise(url);
    assert.deepStrictEqual(await within(first, 'superseded connection'), [false, 'superseded']);
    onOpen.call(oldSocket, { type: 'open', target: oldSocket });
    onError.call(oldSocket, {
        type: 'error', target: oldSocket, message: 'late error', error: new Error('late error'),
    });
    onClose.call(oldSocket, {
        type: 'close', target: oldSocket, code: 1006, reason: 'late close', wasClean: false,
    });
    // 伪造旧连接的 system 消息；新连接最终应获得真实 ID 1，而不是这里的 999。
    onMessage.call(oldSocket, {
        type: 'message',
        target: oldSocket,
        data: JSON.stringify({ eventName: 'system', data: { id: 999, maxSendLen: 1, maxRecvLen: 1 } }),
    });
    assert(client.isConnecting());
    assert(client.timeoutHandle);
    assert.deepStrictEqual(await within(second, 'replacement connection'), [true, '']);
    await waitUntil(() => client.getServerId() > 0, 'replacement server id');
    await waitUntil(() => oldSocket.readyState === WebSocket.CLOSED, 'old socket closed');
    assert.equal(client.getServerId(), 1);
    assert.equal(server.clientsNum(), 1);
    assert.deepStrictEqual(client.events.names(), ['connect']);
});

// 用 connect() 切换到另一个同样不完成握手的地址，再用 connectPromise() 等待新连接。
// 旧连接必须结束为 superseded；其关闭事件不能清掉新连接的定时器，新连接仍应正常超时。
test('switching with connect() preserves the new connection timeout', async context => {
    const oldServer = await createStalledServer(context);
    const newServer = await createStalledServer(context);
    const client = createClient(context);
    const first = client.connectPromise(oldServer.url, 1000);
    await waitUntil(() => oldServer.sockets.size === 1, 'old TCP connection');
    const oldSocket = client.ws;
    assert.equal(client.connect(newServer.url, 250), true);
    const second = client.connectPromise(newServer.url);
    assert.deepStrictEqual(await within(first, 'superseded attempt'), [false, 'superseded']);
    assert.deepStrictEqual(await within(second, 'replacement timeout'), [false, 'timeout']);
    await client.events.waitForCount('close', 1);
    assert.equal(oldSocket.readyState, WebSocket.CLOSED);
    assert.deepStrictEqual(client.events.names(), ['connect_fail', 'error', 'close']);
});

// 在 connect_fail(timeout) 回调内部立刻重连一个正常服务器。
// 旧超时处理后续的清理不能误关刚创建的新 socket；最终应先失败一次，再连接成功。
test('timeout callback can immediately start another connection', async context => {
    const stalled = await createStalledServer(context);
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    let retry: Promise<[boolean, string]>;
    client.onEvent('connect_fail', reason => {
        assert.equal(reason, 'timeout');
        retry = client.connectPromise(url);
    });
    assert.deepStrictEqual(await within(client.connectPromise(stalled.url, 50), 'initial timeout'), [false, 'timeout']);
    assert(retry);
    assert.deepStrictEqual(await within(retry, 'retry from timeout callback'), [true, '']);
    assert(client.isConnected());
    assert.equal(server.clientsNum(), 1);
    assert.deepStrictEqual(client.events.names(), ['connect_fail', 'connect']);
});

// 首次连接被拒绝时，在 connect_fail 回调中立即重试同一地址，不等待旧 socket 的 close。
// 地址依然无人监听，所以两次都应返回 error；旧 close 不能抢先把第二次结果改为 close。
test('error callback can retry the same URL before the old close event', async context => {
    const { url } = await unusedAddress(context);
    const client = createClient(context);
    let retry: Promise<[boolean, string]>;
    client.onEvent('connect_fail', () => {
        if (!retry) retry = client.connectPromise(url);
    });
    const first = client.connectPromise(url);
    assert.deepStrictEqual(await within(first, 'initial error'), [false, 'error']);
    assert(retry);
    assert.deepStrictEqual(await within(retry, 'retry from error callback'), [false, 'error']);
    await client.events.waitForCount('close', 1);
    assert.equal(client.events.count('connect_fail'), 2);
    assert.equal(client.events.count('connect'), 0);
    assert.equal(client.timeoutHandle, null);
});

// 非法 URL 会使 WebSocket 构造函数抛错，但两个连接接口都应转换为失败结果和失败事件。
// 此时没有创建 socket，所以不产生 close；随后同一客户端仍能连接合法地址。
test('invalid URLs fail consistently and allow immediate retry', async context => {
    const { url } = await createLiteServer(context);
    const client = createClient(context);
    assert.deepStrictEqual(await within(client.connectPromise('invalid URL'), 'invalid URL'), [false, 'error']);
    assert.equal(client.connect('invalid URL'), false);
    assert.equal(client.events.count('connect_fail'), 2);
    assert.equal(client.events.count('error'), 2);
    assert.equal(client.events.count('close'), 0);
    assert.equal(client.ws, undefined);
    assert.equal(client.timeoutHandle, null);
    assert(!client.isConnecting());
    await connect(client, url);
    assert.equal(client.events.count('connect'), 1);
});

// 非法 URL 的失败回调是同步触发的；在回调内改连合法 URL，也不能被外层失败处理覆盖。
test('invalid URL callback can immediately retry a valid URL', async context => {
    const { url } = await createLiteServer(context);
    const client = createClient(context);
    let retry: Promise<[boolean, string]>;
    client.onEvent('connect_fail', () => {
        retry = client.connectPromise(url);
    });
    assert.deepStrictEqual(await client.connectPromise('invalid URL'), [false, 'error']);
    assert(retry);
    assert.deepStrictEqual(await within(retry, 'retry after invalid URL'), [true, '']);
    assert(client.isConnected());
    assert.deepStrictEqual(client.events.names(), ['connect_fail', 'connect']);
});

// 已连接服务器 A 后主动切换到服务器 B，应关闭 A 的 socket，并从 A 的客户端列表中移除。
// B 的 system 消息到达前，旧 serverId、消息上限等系统信息必须清空，不能沿用 A 的信息。
test('switching an established connection closes the old socket and resets system state', async context => {
    const first = await createLiteServer(context);
    const second = await createLiteServer(context);
    const client = createClient(context);
    await connect(client, first.url);
    const oldSocket = client.ws;
    assert(client.getSys());
    const replacement = client.connectPromise(second.url);
    assert.equal(client.getServerId(), 0);
    assert.equal(client.getSys(), undefined);
    assert.equal(client.getMaxSendLen(), 1024 * 1024);
    assert.equal(client.getMaxRecvLen(), 1024 * 1024);
    assert.deepStrictEqual(await within(replacement, 'switch established connection'), [true, '']);
    await waitUntil(() => first.server.clientsNum() === 0, 'old server client removed');
    assert.equal(oldSocket.readyState, WebSocket.CLOSED);
    assert.equal(second.server.clientsNum(), 1);
    assert.deepStrictEqual(client.events.names(), ['connect', 'connect']);
    assert(client.isConnected());
});

// 服务端断开连接时，在客户端 disconnect 回调中立即重连，不等待旧 close 事件。
// 新连接应得到新的服务端 ID，且不能被旧 close 事件打断或误报失败。
test('disconnect callback can reconnect without the old close affecting the new attempt', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    await connect(client, url);
    const oldId = client.getServerId();
    let retry: Promise<[boolean, string]>;
    client.onEvent('disconnect', () => {
        if (!retry) retry = client.connectPromise(url);
    });
    server.findById(oldId).disconnect();
    await client.events.waitForCount('disconnect', 1);
    assert(retry);
    assert.deepStrictEqual(await within(retry, 'retry from disconnect callback'), [true, '']);
    await waitUntil(() => client.getServerId() > oldId && server.clientsNum() === 1, 'new server client');
    assert.deepStrictEqual(client.events.names(), ['connect', 'disconnect', 'connect']);
    assert(client.isConnected());
    assert.equal(client.timeoutHandle, null);
});

// 先连接无人监听的端口并失败，再在该端口启动服务器。
// 使用同一客户端重试应成功，但底层必须创建一个新的 WebSocket。
test('failed client can retry successfully', async context => {
    const { url, port } = await unusedAddress(context);
    const client = createClient(context);
    assert.deepStrictEqual(await within(client.connectPromise(url), 'initial failure'), [false, 'error']);
    await client.events.waitForCount('close', 1);
    const oldSocket = client.ws;
    const { server } = await createLiteServer(context, port);
    await connect(client, url);
    assert.notEqual(client.ws, oldSocket);
    assert.equal(client.events.count('connect'), 1);
    assert.equal(client.events.count('connect_fail'), 1);
    assert.equal(server.clientsNum(), 1);
});

// TCP 已接通、WebSocket 握手未完成时主动取消连接。
// 等待中的 Promise 必须结束；因为从未连接成功，只能报 connect_fail，不能报 disconnect。
test('disconnect during handshake fails once and settles connectPromise', async context => {
    const { url, sockets } = await createStalledServer(context);
    const client = createClient(context);
    const result = client.connectPromise(url);
    assert(client.isConnecting());
    await waitUntil(() => sockets.size === 1, 'TCP connection accepted');
    client.disconnect();
    assert.deepStrictEqual(await within(result, 'cancelled connection'), [false, 'error']);
    await client.events.waitForCount('close', 1);
    assert.deepStrictEqual(client.events.names(), ['connect_fail', 'error', 'close']);
    assert(!client.isConnected());
    assert(!client.isConnecting());
    assert.equal(client.timeoutHandle, null);
});

// 完整执行“成功连接 → 主动断开 → 同一实例重连 → 服务端断开”。
// 检查 socket、服务端 ID 已更新，而且两轮断开都能各自触发一次事件并清理连接。
test('successfully disconnected client can connect again', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    await connect(client, url);
    const oldSocket = client.ws;
    const oldId = client.getServerId();
    await disconnectAndCheck(server, client, () => client.disconnect(), SocketCloseCode.disconnect, '');
    await connect(client, url);
    await waitUntil(() => client.getServerId() !== oldId, 'new server id');
    assert.notEqual(client.ws, oldSocket);
    assert.equal(client.events.count('connect'), 2);
    assert.equal(server.clientsNum(), 1);
    await disconnectAndCheck(server, client, peer => peer.disconnect(SocketCloseCode.test, 'again'),
        SocketCloseCode.test, 'again');
    assert.equal(server.clientsNum(), 0);
});

// 服务端主动发送带自定义关闭码和原因的关闭帧，客户端应收到原样的 code、reason。
// 两端都应先通知业务 disconnect，再通知底层 close，并移除服务端连接记录。
test('server disconnect preserves close code and reason', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    await connect(client, url);
    await disconnectAndCheck(server, client, peer => peer.disconnect(SocketCloseCode.test, 'server disconnect'),
        SocketCloseCode.test, 'server disconnect');
    assert.equal(server.clientsNum(), 0);
});

// 服务端 terminate() 直接切断连接，不进行关闭握手；两端应观察到异常关闭码 1006。
// 即使是异常断线，disconnect 也只能触发一次，且连接记录必须清理。
test('server terminate produces one abnormal disconnect', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    await connect(client, url);
    await disconnectAndCheck(server, client, peer => peer.terminate(), 1006, '');
    assert.equal(server.clientsNum(), 0);
});

// 同时连接两个客户端后关闭整个服务器，验证所有客户端都收到正常关闭并退出连接状态。
// 不能只关闭监听端口而留下已有连接，最终服务端客户端数量应为零。
test('server close disconnects every connected client', async context => {
    const { server, url } = await createLiteServer(context);
    const clients = [createClient(context), createClient(context)];
    await Promise.all(clients.map(client => connect(client, url)));
    const closed = once(server.wss, 'close');
    server.close();
    await within(Promise.all([closed, ...clients.map(client => client.events.waitForCount('close', 1))]),
        'server shutdown');
    for (const client of clients) {
        assert.deepStrictEqual(client.events.names(), ['connect', 'disconnect', 'close']);
        assert.equal(client.events.entries[1].reason, 'close');
        assert.equal(client.events.entries[1].err.code, SocketCloseCode.normal);
        assert(!client.isConnected());
        assert.equal(client.timeoutHandle, null);
    }
    assert.equal(server.clientsNum(), 0);
});

// 主动 close 与被动断开一样通知业务 disconnect，随后再产生底层 close，且各自只触发一次。
test('explicit close invokes disconnect exactly once', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    let disconnectCalls = 0;
    client.onEvent('disconnect', () => { disconnectCalls++; });
    await connect(client, url);
    client.close();
    client.close();
    await Promise.all([
        client.events.waitForCount('close', 1),
        server.events.waitForCount('client-close', 1),
    ]);
    assert.equal(disconnectCalls, 1);
    assert.deepStrictEqual(client.events.names(), ['connect', 'disconnect', 'close']);
});

// destroy 用于静默销毁：关闭连接、清理心跳和所有回调，但不再发出 disconnect、close 或 error。
// 服务端仍会正常观察到客户端断开并清理房间；重复 destroy 也应安全。
test('destroy silently disposes a connected client and all event callbacks', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context, { heartbeatInterval: 10, heartbeatTimeout: 50 });
    const observed: string[] = [];
    let disconnectCalls = 0;
    client.allEventFunc = event => observed.push(event);
    client.onEvent('disconnect', () => { disconnectCalls++; });
    await connect(client, url);
    const peer = server.findById(client.getServerId());
    server.joinRoom('destroyed-client', peer);
    const socket = client.ws;
    const closed = once(socket, 'close');
    client.destroy();
    assert.equal(client.timeoutHandle, null);
    assert.equal(client.getServerId(), 0);
    assert.equal(client.getSys(), undefined);
    assert.equal(client.allEventFunc, undefined);
    assert(!client.isConnected());
    assert(!client.isConnecting());
    await within(closed, 'destroyed socket closed');
    await server.events.waitForCount('client-close', 1);
    assert.doesNotThrow(() => client.destroy());
    await delay(100);
    assert.equal(disconnectCalls, 0);
    assert.deepStrictEqual(observed, ['connect']);
    assert.deepStrictEqual(client.events.names(), ['connect']);
    assert.equal(server.findById(peer.id), undefined);
    assert.equal(server.getRoom('destroyed-client'), undefined);
});

for (const phase of ['handshake', 'system'] as const) {
    // 握手中或等待 system 时 destroy，也不能留下悬挂的 Promise 或触发 connect_fail/disconnect。
    // 销毁操作直接把等待者结束为 destroyed，并忽略底层随后到达的 error、close。
    test(`destroy during ${phase} settles connectPromise without lifecycle events`, async context => {
        const client = createClient(context);
        const observed: string[] = [];
        client.allEventFunc = event => observed.push(event);
        let connecting: Promise<[boolean, string]>;
        if (phase === 'handshake') {
            const { url, sockets } = await createStalledServer(context);
            connecting = client.connectPromise(url);
            await waitUntil(() => sockets.size === 1, 'handshake before destroy');
        } else {
            const { server, url } = await createSystemServer(context);
            const accepted = once(server, 'connection');
            connecting = client.connectPromise(url);
            await within(accepted, 'system wait before destroy');
            await waitUntil(() => client.ws.readyState === WebSocket.OPEN, 'open before destroy');
        }
        // ws 在握手中被终止会发 error，使用原生 close 回调等待，避免 once 因该 error 提前拒绝。
        const closed = new Promise<void>(resolve => client.ws.once('close', () => resolve()));
        client.destroy();
        assert.deepStrictEqual(await within(connecting, 'destroy settles pending connection'), [false, 'destroyed']);
        await within(closed, 'destroy closes pending socket');
        assert.deepStrictEqual(observed, []);
        assert.deepStrictEqual(client.events.names(), []);
        assert.equal(client.timeoutHandle, null);
        assert(!client.isConnecting());
        assert(!client.isConnected());
        assert.doesNotThrow(() => client.destroy());
    });
}

for (const failure of ['invalid-url', 'refused', 'handshake-timeout', 'system-timeout', 'system-close'] as const) {
    // 覆盖地址非法、连接被拒、握手超时、初始化超时，以及初始化前被服务端关闭。
    // 只有完成 system 初始化才算连接成功，所以这些失败都只能通知 connect_fail，不能通知 disconnect。
    test(`connection failure never invokes disconnect: ${failure}`, async context => {
        const client = createClient(context, { connectTimeout: 100 });
        let disconnectCalls = 0;
        let connectFailCalls = 0;
        client.onEvent('disconnect', () => { disconnectCalls++; });
        client.onEvent('connect_fail', () => { connectFailCalls++; });
        let result: [boolean, string];
        if (failure === 'invalid-url') {
            result = await within(client.connectPromise('invalid URL'), 'invalid URL failure');
        } else if (failure === 'refused') {
            const { url } = await unusedAddress(context);
            result = await within(client.connectPromise(url), 'connection refused');
        } else if (failure === 'handshake-timeout') {
            const { url } = await createStalledServer(context);
            result = await within(client.connectPromise(url), 'handshake timeout');
        } else {
            const { server, url } = await createSystemServer(context);
            const accepted = once(server, 'connection');
            const connecting = client.connectPromise(url);
            const [socket] = await within(accepted, 'uninitialized connection');
            if (failure === 'system-close') socket.close(SocketCloseCode.test, 'initialization failed');
            result = await within(connecting, 'system initialization failure');
        }
        const reason = failure.endsWith('timeout') ? 'timeout' : failure === 'system-close' ? 'close' : 'error';
        assert.deepStrictEqual(result, [false, reason]);
        if (client.ws) await client.events.waitForCount('close', 1);
        assert.equal(connectFailCalls, 1);
        assert.equal(disconnectCalls, 0);
        assert.equal(client.events.count('connect_fail'), 1);
        assert.equal(client.events.count('connect'), 0);
        assert.equal(client.events.count('disconnect'), 0);
        assert(!client.isConnected());
        assert(!client.isConnecting());
        assert.equal(client.timeoutHandle, null);
    });
}

for (const interruption of ['server-close', 'server-terminate', 'tcp-destroy', 'socket-error'] as const) {
    // 连接成功后，由服务端关闭、强制断开或直接销毁 TCP 连接，都必须通知业务 disconnect 一次。
    // socket-error 分支主动注入两次底层 error 再关闭连接，确认 error 与 close 不会重复通知 disconnect。
    test(`passive interruption invokes disconnect exactly once: ${interruption}`, async context => {
        const { server, url } = await createLiteServer(context);
        const client = createClient(context);
        const notifications: Array<{ reason: string | number, message?: string }> = [];
        client.onEvent('disconnect', (reason, err) => {
            notifications.push({ reason, message: err?.message });
        });
        await connect(client, url);
        const peer = server.findById(client.getServerId());
        assert(peer);
        assert.equal(notifications.length, 0);
        if (interruption === 'server-close') {
            peer.close(SocketCloseCode.test, 'passive close');
        } else if (interruption === 'server-terminate') {
            peer.terminate();
        } else if (interruption === 'tcp-destroy') {
            // ws 的底层 TCP socket 只在此测试中使用，模拟网络连接直接消失，没有 WebSocket 关闭握手。
            const transport = (peer.ws as unknown as { _socket: import('node:net').Socket })._socket;
            transport.destroy();
        } else {
            client.ws.emit('error', new Error('first socket failure'));
            assert.deepStrictEqual(notifications, [{ reason: 'error', message: 'first socket failure' }]);
            assert.deepStrictEqual(client.events.names(), ['connect', 'disconnect', 'error']);
            client.ws.emit('error', new Error('second socket failure'));
            peer.terminate();
        }
        await Promise.all([
            client.events.waitForCount('close', 1),
            server.events.waitForCount('client-close', 1),
        ]);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].reason, interruption === 'socket-error' ? 'error' : 'close');
        assert.equal(client.events.count('disconnect'), 1);
        assert.equal(client.events.count('connect_fail'), 0);
        assert.deepStrictEqual(client.events.names(), interruption === 'socket-error'
            ? ['connect', 'disconnect', 'error', 'error', 'close'] : ['connect', 'disconnect', 'close']);
        const closed = client.events.entries.find(entry => entry.event === 'close');
        assert.equal(closed.err.code, interruption === 'server-close' ? SocketCloseCode.test : 1006);
        assert(!client.isConnected());
        assert(!client.isConnecting());
        assert.equal(server.findById(peer.id), undefined);
    });
}
