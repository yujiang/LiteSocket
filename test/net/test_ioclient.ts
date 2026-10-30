import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import { createLogger } from '../logger_helpers';
import { IOClient } from '../../src/net/IOClient';
import { IOServer } from '../../src/net/IOServer';
import type { IOServerSocket } from '../../src/net/IOServerSocket';
import type { LiteClientOptionsInput } from '../../src/net/LiteClient';
import type { ClientParam } from '../../src/net/ClientSession';
import { SocketParamEnum } from '../../src/net/msg';
import { MsgId, NetEventEnum } from '../../src/net/msgid';
import { ErrorEnum } from '../../src/net/ErrorEnum';
import { createStalledServer, unusedAddress, waitUntil, within } from '../lite_test_helpers';

const messageId = 900001;

async function setup(context: TestContext, checktimeout = false, opts: LiteClientOptionsInput = {}, param: ClientParam = {}) {
    const logger = createLogger({ silent: true });
    const server = new IOServer('io-client-test', logger);
    const client = new IOClient('io-client-test', logger, { checktimeout, ...param }, { connectTimeout: 1000, ...opts });
    const disconnects: unknown[][] = [];
    context.after(() => {
        client.destroy('test cleanup');
        server.close();
        logger.close();
    });
    assert.deepStrictEqual(await within(server.listen(0), 'server listen'), [true]);
    const url = `ws://127.0.0.1:${server.io.port}`;
    const disconnect = (...args: unknown[]) => { disconnects.push(args); };
    return { client, server, url, disconnect, disconnects };
}

test('sendMsg forwards rest arguments like send while preserving spread input', async context => {
    const { client, server, url, disconnect } = await setup(context);
    const received: unknown[][] = [];
    server.modHandle.register(messageId, (...args: unknown[]) => { received.push(args); },
        null, SocketParamEnum.noSocket, 'sendMsg-test');
    assert((await within(client.connectServer(url, disconnect), 'sendMsg connection'))[0]);
    client.sendMsg(messageId);
    client.sendMsg(messageId, 'hello', 7, { enabled: true }, [1, 2]);
    client.send([messageId, 'legacy']);
    const packet: [number, ...any[]] = [messageId, 'spread'];
    client.sendMsg(...packet);
    assert.deepStrictEqual(packet, [messageId, 'spread']);
    await waitUntil(() => received.length === 4, 'sendMsg delivery');
    // 普通消息沿用 send 的封包规则，末尾的 0 表示不等待 RPC 回调。
    assert.deepStrictEqual(received, [
        [0], ['hello', 7, { enabled: true }, [1, 2], 0], ['legacy', 0], ['spread', 0],
    ]);
});

function holdRequests(server: IOServer) {
    let received = 0;
    server.cbHandle.register(messageId, () => {
        received++;
        return new Promise(() => {});
    }, null, SocketParamEnum.noSocket, 'pending-request');
    return () => received;
}

function trackIntervals(context: TestContext) {
    const timers: Array<{ timer: NodeJS.Timeout, run: () => void, timeout: number, cleared: boolean }> = [];
    const set = global.setInterval;
    const clear = global.clearInterval;
    context.mock.method(global, 'setInterval', (handler: () => void, timeout: number) => {
        const timer = set(handler, timeout);
        timers.push({ timer, run: handler, timeout, cleared: false });
        return timer;
    });
    context.mock.method(global, 'clearInterval', (timer: NodeJS.Timeout) => {
        const entry = timers.find(entry => entry.timer === timer);
        if (entry) entry.cleared = true;
        clear(timer);
    });
    return timers;
}

// 连接成功后，普通消息和 RPC 均能发送，不再误判为 socket.io 的 connected=false。
test('connected client sends messages and receives callback replies', async context => {
    const { client, server, url, disconnect } = await setup(context);
    const messages: string[] = [];
    server.modHandle.register(messageId, (value: string) => messages.push(value),
        null, SocketParamEnum.noSocket, 'message');
    server.cbHandle.register(messageId, (value: number) => [ErrorEnum.ErrorOk, value * 2],
        null, SocketParamEnum.noSocket, 'callback');
    assert.deepStrictEqual(await client.connectServer(url, disconnect), [true, '']);
    assert(client.callback.isSessionConnect());
    assert.equal(client.callback.socket, client.socket);
    client.send([messageId, 'send']);
    client.sendMod(NetEventEnum.eventMod, [messageId, 'sendMod']);
    assert.deepStrictEqual(await within(client.asend([messageId, 6]), 'asend'), [ErrorEnum.ErrorOk, 12]);
    assert.equal(await client.asende([messageId, 7]), ErrorEnum.ErrorOk);
    await waitUntil(() => messages.length === 2, 'messages');
    assert.deepStrictEqual(messages, ['send', 'sendMod']);
});

// 业务处理函数在连接前绑定；刚连接就到达的广播和服务端 RPC 也能正确处理。
test('handlers registered before connecting receive broadcast and server requests', async context => {
    const { client, server, url, disconnect } = await setup(context);
    const messages: string[] = [];
    client.bcHandle.register(messageId, (value: string) => messages.push(value),
        null, SocketParamEnum.noSocket, 'broadcast');
    client.handle.getMsghandleCallback().register(messageId, (value: number) => [ErrorEnum.ErrorOk, value + 1],
        null, SocketParamEnum.noSocket, 'server-request');
    const onConnected = server.onClientConnected.bind(server);
    context.mock.method(server, 'onClientConnected', (socket: IOServerSocket) => {
        onConnected(socket);
        socket.emit(NetEventEnum.eventBc, [messageId, 'hello']);
    });
    assert((await client.connectServer(url, disconnect))[0]);
    const socket = server.findById(client.socket.getServerId());
    assert.deepStrictEqual(await within(socket.session.asendSession(NetEventEnum.eventCallback, [messageId, 4], 0),
        'server request'), [ErrorEnum.ErrorOk, 5]);
    await waitUntil(() => messages.length === 1, 'early broadcast');
});

// 初始状态和主动关闭之后，发送不抛异常，RPC 明确返回未连接。
test('sending before connection and after close returns not connected', async context => {
    const { client, url, disconnect } = await setup(context);
    async function checkDisconnected() {
        assert.doesNotThrow(() => client.send([messageId]));
        assert.doesNotThrow(() => client.sendMod(NetEventEnum.eventMod, [messageId]));
        assert.deepStrictEqual(await client.asend([messageId]), [ErrorEnum.Net_notconnect, null]);
        assert.equal(await client.asende([messageId]), ErrorEnum.Net_notconnect);
    }
    await checkDisconnected();
    assert((await client.connectServer(url, disconnect))[0]);
    client.destroy('closed');
    await checkDisconnected();
});

// 建连失败只返回 false，不通知 disconnect，并清理本次 socket 和 callback。
test('failed connection does not notify disconnect', async context => {
    const { client, disconnect, disconnects } = await setup(context);
    const { url } = await unusedAddress(context);
    assert.deepStrictEqual(await within(client.connectServer(url, disconnect), 'failed connection'), [false, 'error']);
    assert.equal(client.socket, undefined);
    assert.equal(client.callback, undefined);
    assert.deepStrictEqual(disconnects, []);
    assert.deepStrictEqual(await client.asend([messageId]), [ErrorEnum.Net_notconnect, null]);
});

test('connectServer accepts the LiteClient connect timeout argument', async context => {
    const { client } = await setup(context);
    const stalled = await createStalledServer(context);
    assert.deepStrictEqual(await within(client.connectServer(stalled.url, 50), 'connection timeout', 500), [false, 'timeout']);
    assert.equal(client.socket, undefined);
});

// 网络断开时恰好通知一次，并让尚未收到响应的 RPC 返回断线错误。
test('network disconnect notifies once and settles pending requests', async context => {
    const { client, server, url, disconnect, disconnects } = await setup(context);
    const received = holdRequests(server);
    assert((await client.connectServer(url, disconnect))[0]);
    const pending = client.asend([messageId]);
    await waitUntil(() => received() === 1, 'request received');
    server.io.findById(client.socket.getServerId()).terminate();
    assert.equal((await within(pending, 'disconnected request'))[0], ErrorEnum.Callback_disconnect);
    await waitUntil(() => disconnects.length === 1, 'disconnect notified');
    assert.equal(client.socket, undefined);
    assert.equal(client.callback, undefined);
    assert.equal(disconnects.length, 1);
});

// closeSocket 使用静默 destroy，不通知外部 disconnect，但必须结束所有待响应请求。
test('explicit close silently settles all pending requests', async context => {
    const { client, server, url, disconnect, disconnects } = await setup(context);
    const received = holdRequests(server);
    assert((await client.connectServer(url, disconnect))[0]);
    const pending = client.asend([messageId]);
    const pendingError = client.asende([messageId]);
    await waitUntil(() => received() === 2, 'requests received');
    client.destroy('manual close');
    client.destroy('repeated close');
    assert.deepStrictEqual(await within(pending, 'closed request'), [ErrorEnum.Callback_disconnect, 'manual close']);
    assert.equal(await within(pendingError, 'closed error request'), ErrorEnum.Callback_disconnect);
    assert.deepStrictEqual(disconnects, []);
});

// 直接调用底层 socket.close 仍通知断线，区别于 IOClient.closeSocket 的静默 destroy。
test('socket close notifies disconnect while wrapper close is silent', async context => {
    const { client, url, disconnect, disconnects } = await setup(context);
    assert((await client.connectServer(url, disconnect))[0]);
    client.socket.close();
    await waitUntil(() => disconnects.length === 1, 'socket close notification');
    assert.equal(client.socket, undefined);
    assert.deepStrictEqual(await client.asend([messageId]), [ErrorEnum.Net_notconnect, null]);
    client.destroy('already closed');
    assert.equal(disconnects.length, 1);
});

// 连接尚未完成时调用关闭，连接立即取消，之后也不会“复活”为已连接状态。
test('close cancels an in-flight connection', async context => {
    const { client, disconnect, disconnects } = await setup(context);
    const { url, sockets } = await createStalledServer(context);
    const connecting = client.connectServer(url, disconnect);
    const socket = client.socket;
    await waitUntil(() => sockets.size === 1, 'connecting socket');
    assert.doesNotThrow(() => client.send([messageId]));
    assert.deepStrictEqual(await client.asend([messageId]), [ErrorEnum.Net_notconnect, null]);
    client.destroy('cancel connect');
    assert.deepStrictEqual(await within(connecting, 'cancelled connection'), [false, 'destroyed']);
    assert.equal(socket.isConnected(), false);
    assert.equal(client.socket, undefined);
    assert.deepStrictEqual(disconnects, []);
});

// 连续发起连接时销毁前一次尝试，旧尝试的返回结果不能清理或覆盖新连接。
test('new connection supersedes an in-flight attempt', async context => {
    const { client, url, disconnect, disconnects } = await setup(context);
    const stalled = await createStalledServer(context);
    const previous = client.connectServer(stalled.url, disconnect);
    const oldSocket = client.socket;
    const current = client.connectServer(url, disconnect);
    assert.deepStrictEqual(await within(previous, 'superseded connection'), [false, 'destroyed']);
    assert((await within(current, 'current connection'))[0]);
    assert.notEqual(client.socket, oldSocket);
    assert(client.socket.isConnected());
    assert.equal(client.serverUrl, url);
    assert.deepStrictEqual(disconnects, []);
});

// 已连接时再次连接，旧 socket 的 RPC 被结算，旧断线不会干扰新连接。
test('reconnecting settles old requests and preserves the new connection', async context => {
    const { client, server, url, disconnect, disconnects } = await setup(context);
    const received = holdRequests(server);
    assert((await client.connectServer(url, disconnect))[0]);
    const oldSocket = client.socket;
    const pending = client.asend([messageId]);
    await waitUntil(() => received() === 1, 'old request');
    assert((await client.connectServer(url, disconnect))[0]);
    assert.equal((await within(pending, 'old request settled'))[0], ErrorEnum.Callback_disconnect);
    assert.notEqual(client.socket, oldSocket);
    assert(client.socket.isConnected());
    assert.deepStrictEqual(disconnects, []);
});

// disconnect 回调允许立即重连；旧连接先完成清理，不能把新连接 callback 清掉。
test('disconnect callback can immediately reconnect and receives error details', async context => {
    const { client, server, url } = await setup(context);
    let reconnecting: Promise<[boolean, string]>;
    const error = new Error('connection lost');
    const events: unknown[][] = [];
    assert((await client.connectServer(url, (reason, err) => {
        events.push([reason, err]);
        reconnecting = client.connectServer(url, () => {});
    }))[0]);
    const oldSocket = client.socket;
    oldSocket.emitDisconnect('error', error);
    assert((await within(reconnecting, 'reconnect from disconnect'))[0]);
    oldSocket.emitDisconnect('close');
    assert.deepStrictEqual(events, [['error', error]]);
    assert(client.socket.isConnected());
    assert.deepStrictEqual(await within(client.asend([MsgId.MSG_SYSTEM_QUERYHTTPSERVER, 'name']), 'new RPC'),
        [ErrorEnum.ErrorOk, server.name]);
});

// IOClient 的轮询定时器触发 ClientSession 检查；销毁释放定时器，已排队的旧回调也不再执行检查。
test('IOClient owns the timeout interval and releases it on destroy', async context => {
    const timers = trackIntervals(context);
    const { client, server, url, disconnect } = await setup(context, true);
    const serverTimerCount = timers.length;
    const received = holdRequests(server);
    assert((await client.connectServer(url, disconnect))[0]);
    const callback = client.callback;
    const check = context.mock.method(callback, 'onCheck');
    const interval = timers[serverTimerCount];
    assert.equal(interval.timeout, 1000);
    assert.equal(interval.timer.hasRef(), false);
    const pending = client.asend([messageId], 10);
    await waitUntil(() => received() === 1, 'timeout request');
    const now = Date.now();
    context.mock.method(Date, 'now', () => now + 100);
    interval.run();
    assert.equal((await within(pending, 'timed out request'))[0], ErrorEnum.Callback_timeout);
    assert.equal(check.mock.callCount(), 1);
    client.destroy('timer cleanup');
    assert(timers.length >= serverTimerCount + 2);
    assert(timers.slice(serverTimerCount).every(entry => entry.cleared));
    interval.run();
    assert.equal(check.mock.callCount(), 1);
    assert.equal(callback.socket, null);
    assert.deepStrictEqual(callback.callbacks, {});
});

// 开启自动重连后，IOClient 断线只结算旧请求，不销毁底层实例和已注册的消息处理器。
test('IOClient preserves its transport and callbacks across automatic reconnect', async context => {
    const timers = trackIntervals(context);
    const { client, server, url, disconnect, disconnects } = await setup(context, true, {
        autoReconnect: true, backoff: { baseMs: 80, maxMs: 80, jitter: 0, maxRetries: 2 },
    });
    const received = holdRequests(server);
    const serverTimerCount = timers.length;
    assert((await client.connectServer(url, disconnect))[0]);
    const interval = timers[serverTimerCount];
    const timerCountBeforeDisconnect = timers.length;
    const socket = client.socket;
    const callback = client.callback;
    const oldId = socket.getServerId();
    const pending = client.asend([messageId]);
    await waitUntil(() => received() === 1, 'pending request before reconnect');
    server.io.findById(oldId).terminate();
    assert.equal((await within(pending, 'request interrupted by reconnect'))[0], ErrorEnum.Callback_disconnect);
    await waitUntil(() => socket.isConnected() && socket.getServerId() !== oldId, 'IOClient reconnect');
    assert.equal(client.socket, socket);
    assert.equal(client.callback, callback);
    assert.equal(callback.socket, socket);
    assert.equal(interval.cleared, false);
    assert.equal(timers.length, timerCountBeforeDisconnect + 1);
    assert.equal(disconnects.length, 1);
    assert.deepStrictEqual(await within(client.asend([MsgId.MSG_SYSTEM_QUERYHTTPSERVER, 'name']), 'RPC after reconnect'),
        [ErrorEnum.ErrorOk, server.name]);
});

// 首次连接失败时，IOClient 仍返回 false，但启用自动重连后保留实例，让后台重试继续。
test('IOClient does not destroy an automatic client after initial connection failure', async context => {
    const { client, server, disconnect, disconnects } = await setup(context, false, {
        autoReconnect: true, backoff: { baseMs: 100, maxMs: 100, jitter: 0, maxRetries: 2 },
    });
    const { url, port } = await unusedAddress(context);
    assert.deepStrictEqual(await client.connectServer(url, disconnect), [false, 'error']);
    const socket = client.socket;
    assert(socket);
    assert.deepStrictEqual(await server.listen(port), [true]);
    await waitUntil(() => socket.isConnected(), 'IOClient recovery after initial failure');
    assert.equal(client.socket, socket);
    assert.deepStrictEqual(disconnects, []);
    assert.deepStrictEqual(await within(client.asend([MsgId.MSG_SYSTEM_QUERYHTTPSERVER, 'name']), 'recovered RPC'),
        [ErrorEnum.ErrorOk, server.name]);
});

// 未开启 checktimeout 时，除底层心跳外不会创建额外的请求轮询定时器。
test('IOClient does not create a timeout interval when checking is disabled', async context => {
    const timers = trackIntervals(context);
    const { client, url, disconnect } = await setup(context, false, {}, { checkIntervalMs: 25 });
    const serverTimerCount = timers.length;
    assert((await client.connectServer(url, disconnect))[0]);
    assert.equal(timers.length, serverTimerCount + 1);
});

// 首次连接失败或握手期间被销毁，都释放 IOClient 自己的轮询定时器。
for (const action of ['fail', 'cancel'] as const) {
    test(`IOClient releases its timeout interval on connection ${action}`, async context => {
        const timers = trackIntervals(context);
        const { client, disconnect } = await setup(context, true);
        const serverTimerCount = timers.length;
        const { url } = action === 'fail' ? await unusedAddress(context) : await createStalledServer(context);
        const connecting = client.connectServer(url, disconnect);
        const interval = timers[serverTimerCount];
        const callback = client.callback;
        const check = context.mock.method(callback, 'onCheck');
        if (action === 'cancel') client.destroy('cancel pending connection');
        const [connected] = await within(connecting, 'failed or cancelled connection');
        assert.equal(connected, false);
        assert(interval.cleared);
        interval.run();
        assert.equal(check.mock.callCount(), 0);
        assert.equal(callback.socket, null);
    });
}

// 手动换连接时释放旧定时器并创建新的；旧定时器不能检查旧 callback 或误操作新 callback。
test('IOClient replaces its timeout interval when manually reconnecting', async context => {
    const timers = trackIntervals(context);
    const { client, url, disconnect } = await setup(context, true);
    const serverTimerCount = timers.length;
    assert((await client.connectServer(url, disconnect))[0]);
    const oldInterval = timers[serverTimerCount];
    const oldCheck = context.mock.method(client.callback, 'onCheck');
    const timerCount = timers.length;
    assert((await client.connectServer(url, disconnect))[0]);
    const newInterval = timers[timerCount];
    const newCheck = context.mock.method(client.callback, 'onCheck');
    assert(oldInterval.cleared);
    assert.equal(newInterval.cleared, false);
    oldInterval.run();
    assert.equal(oldCheck.mock.callCount(), 0);
    assert.equal(newCheck.mock.callCount(), 0);
    newInterval.run();
    assert.equal(newCheck.mock.callCount(), 1);
    client.destroy('done');
    assert(newInterval.cleared);
});

// ClientParam 可单独配置检查周期；实际定时器按该周期检查并结算过期请求。
test('IOClient uses the timeout check interval supplied through ClientParam', async context => {
    const timers = trackIntervals(context);
    const { client, server, url, disconnect } = await setup(context, true, {}, { checkIntervalMs: 25 });
    const serverTimerCount = timers.length;
    holdRequests(server);
    assert((await client.connectServer(url, disconnect))[0]);
    assert.equal(timers[serverTimerCount].timeout, 25);
    const [code] = await within(client.asend([messageId], 1), 'custom interval timeout');
    assert.equal(code, ErrorEnum.Callback_timeout);
});

// 非正数或非有限数不能让轮询变成忙循环，统一回退到默认 1000ms。
for (const checkIntervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`IOClient falls back to one second for invalid interval ${checkIntervalMs}`, async context => {
        const timers = trackIntervals(context);
        const { client, url, disconnect } = await setup(context, true, {}, { checkIntervalMs });
        const serverTimerCount = timers.length;
        assert((await client.connectServer(url, disconnect))[0]);
        assert.equal(timers[serverTimerCount].timeout, 1000);
    });
}
