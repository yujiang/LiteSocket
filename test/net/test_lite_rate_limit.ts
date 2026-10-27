import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { test, TestContext } from 'node:test';
import { LiteServer } from '../../src/net/LiteServer';
import { LiteSocket } from '../../src/net/LiteSocket';
import { LiteOptionsInput, SocketCloseCode } from '../../src/net/LiteNet';
import { ErrorEnum } from '../../src/net/ErrorEnum';
import { createIOPair } from '../io_test_helpers';
import { connect, createClient, createLiteServer, within } from '../lite_test_helpers';

async function createConnection(context: TestContext, opts: LiteOptionsInput = {}) {
    let now = 0;
    context.mock.method(performance, 'now', () => now);
    const { server, url } = await createLiteServer(context, 0, opts);
    const client = createClient(context);
    await connect(client, url);
    const peer = server.findById(client.getServerId());
    const messages: number[] = [];
    peer.on('payload', data => messages.push(data));
    const send = (value: number, event = 'payload') => {
        peer.ws.emit('message', Buffer.from(LiteSocket.encodeMessage(event, value)));
    };
    const closed = async () => {
        await within(Promise.all([once(peer.ws, 'close'), once(client.ws, 'close')]), 'rate-limited connection close');
    };
    return { server, client, peer, messages, send, closed, url, advance: (ms: number) => { now += ms; } };
}

// 没有配置时保持原行为，大量连续消息不会启用限流或断开连接。
test('message rate limiting is disabled by default', async context => {
    const { client, peer, messages, send } = await createConnection(context);
    for (let index = 0; index < 200; index++) send(index);
    assert.equal(messages.length, 200);
    assert(client.connected);
    assert(peer.connected);
});

// 初始额度等于 burst；超出额度的那条消息不派发，走正常踢人和房间清理流程。
test('initial burst is allowed and the next message disconnects the client', async context => {
    const intervals = context.mock.method(globalThis, 'setInterval');
    const { server, client, peer, messages, send, closed } = await createConnection(context, {
        messageRateLimit: { perSecond: 1, burst: 3 },
    });
    assert.equal(intervals.mock.callCount(), 2);
    peer.join('limited');
    send(1);
    send(2);
    send(3);
    assert.deepStrictEqual(messages, [1, 2, 3]);
    assert(peer.connected);
    send(4);
    await closed();
    assert.deepStrictEqual(messages, [1, 2, 3]);
    assert.equal(server.clientsNum(), 0);
    assert.equal(server.getRoom('limited'), undefined);
    assert.equal(client.events.count('disconnect'), 1);
    assert.equal(server.events.count('client-disconnect'), 1);
    const close = client.events.entries.find(entry => entry.event === 'close');
    assert.equal(close.err.code, SocketCloseCode.disconnect);
    assert.equal(close.err.reason, 'message rate limit');
});

// 按实际经过时间补充额度并保留小数；750ms 获得 1.5 个额度，剩余半个可以继续积攒。
test('tokens refill with elapsed time and preserve fractional tokens', async context => {
    const { messages, send, advance, peer, closed } = await createConnection(context, {
        messageRateLimit: { perSecond: 2, burst: 2 },
    });
    send(1);
    send(2);
    advance(750);
    send(3);
    advance(250);
    send(4);
    assert.deepStrictEqual(messages, [1, 2, 3, 4]);
    assert(peer.connected);
    send(5);
    await closed();
    assert.deepStrictEqual(messages, [1, 2, 3, 4]);
});

// 模拟网络阻塞后集中到达：空闲期间可以攒满 60 个额度，但长时间空闲也不能突破容量上限。
test('idle time permits a delayed batch without accumulating beyond burst capacity', async context => {
    const { messages, send, advance, peer, closed } = await createConnection(context, {
        messageRateLimit: { perSecond: 1, burst: 60 },
    });
    for (let index = 0; index < 60; index++) send(index);
    advance(600000);
    for (let index = 60; index < 120; index++) send(index);
    assert.equal(messages.length, 120);
    assert(peer.connected);
    send(120);
    await closed();
    assert.equal(messages.length, 120);
});

// ping/pong 在限流前处理，即使业务额度已经耗尽，心跳也不消耗额度或触发踢人。
test('heartbeat packets do not consume message tokens', async context => {
    const { peer, messages, send, advance, closed } = await createConnection(context, {
        messageRateLimit: { perSecond: 1, burst: 1 },
    });
    send(1);
    for (let index = 0; index < 5; index++) {
        peer.ws.emit('message', Buffer.from(LiteSocket.encodeMessage('ping', Date.now())));
        peer.ws.emit('message', Buffer.from(LiteSocket.encodeMessage('pong', [Date.now(), Date.now()])));
    }
    assert(peer.connected);
    advance(1000);
    send(2);
    assert.deepStrictEqual(messages, [1, 2]);
    send(3);
    await closed();
});

// 单连接处理器和服务器全局处理器共用同一个桶，不能靠换消息名或换注册方式绕过限制。
test('local and global message handlers share one rate limit', async context => {
    const { server, peer, messages, send, closed } = await createConnection(context, {
        messageRateLimit: { perSecond: 1, burst: 2 },
    });
    const global: number[] = [];
    server.onMessage('global', (socket, data) => global.push(data));
    send(1);
    send(2, 'global');
    assert(peer.connected);
    send(3, 'global');
    await closed();
    assert.deepStrictEqual(messages, [1]);
    assert.deepStrictEqual(global, [2]);
});

// 各连接独立计算额度，一个客户端被踢掉不会消耗另一个客户端的额度。
test('each client has its own token bucket', async context => {
    const { server, url, messages, send, advance, closed } = await createConnection(context, {
        messageRateLimit: { perSecond: 1, burst: 1 },
    });
    const other = createClient(context);
    await connect(other, url);
    const otherPeer = server.findById(other.getServerId());
    const otherMessages: number[] = [];
    otherPeer.on('payload', data => otherMessages.push(data));
    send(1);
    otherPeer.ws.emit('message', Buffer.from(LiteSocket.encodeMessage('payload', 2)));
    send(3);
    await closed();
    assert.deepStrictEqual(messages, [1]);
    assert.deepStrictEqual(otherMessages, [2]);
    assert(otherPeer.connected);
    advance(1000);
    otherPeer.ws.emit('message', Buffer.from(LiteSocket.encodeMessage('payload', 4)));
    assert.deepStrictEqual(otherMessages, [2, 4]);
    assert(otherPeer.connected);
});

// 配置错误在创建服务器时明确报错，避免 NaN、零速率或非法容量让限流行为不可预期。
test('message rate limit rejects invalid configuration', () => {
    for (const perSecond of [0, -1, Number.NaN, Infinity]) {
        assert.throws(() => new LiteServer('invalid-rate', console, { messageRateLimit: { perSecond, burst: 1 } }), RangeError);
    }
    for (const burst of [0, -1, 1.5, Number.NaN, Infinity]) {
        assert.throws(() => new LiteServer('invalid-burst', console, { messageRateLimit: { perSecond: 1, burst } }), RangeError);
    }
});

// IOClient 的 RPC 也纳入限流；超限请求通过断线结束，不会等待超时或留在回调表里。
test('rate-limited RPCs settle through the normal disconnect path', async context => {
    const { server, client, connect: connectClient } = await createIOPair(context, { checktimeout: false }, {
        messageRateLimit: { perSecond: 0.01, burst: 1 },
    });
    let handled = 0;
    server.onCallback(910007, () => { handled++; return [ErrorEnum.ErrorOk, 'accepted']; });
    await connectClient();
    const callback = client.callback;
    assert.deepStrictEqual(await client.asend([910007]), [ErrorEnum.ErrorOk, 'accepted']);
    const [code] = await within(client.asend([910007]), 'rate-limited RPC');
    assert.equal(code, ErrorEnum.Callback_disconnect);
    assert.equal(handled, 1);
    assert.deepStrictEqual(callback.callbacks, {});
});
