import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LiteClientOptionsInput } from '../../src/net/LiteClient';
import {
    closeServer, createLiteServer, createStalledServer, LiteClientTest,
    terminateClient, unusedAddress, waitUntil, within,
} from '../lite_test_helpers';

function createClient(context: TestContext, opts: LiteClientOptionsInput = {}) {
    const client = new LiteClientTest({
        connectTimeout: 100,
        autoReconnect: true,
        ...opts,
        backoff: { baseMs: 40, maxMs: 40, jitter: 0, maxRetries: 2, ...opts.backoff },
    });
    context.after(async () => {
        client.destroy();
        await terminateClient(client);
    });
    return client;
}

// 默认值或显式 false 都只尝试连接一次，不会额外通知重连事件。
for (const autoReconnect of [undefined, false]) {
    test(`autoReconnect=${autoReconnect} preserves one-shot connection behavior`, async context => {
        const { url } = await unusedAddress(context);
        const client = createClient(context, { autoReconnect });
        assert.deepStrictEqual(await client.connectPromise(url), [false, 'error']);
        await client.events.waitForCount('close', 1);
        const count = client.events.entries.length;
        await delay(130);
        assert.equal(client.events.entries.length, count);
        assert.equal(client.events.count('connect_fail'), 1);
        assert.equal(client.events.count('reconnect'), 0);
        assert.equal(client.events.count('retries_exhausted'), 0);
    });
}

// 没有传入该选项时，实例明确采用 autoReconnect=false。
test('autoReconnect is disabled by default', async context => {
    const client = new LiteClientTest();
    context.after(() => client.destroy());
    assert.equal(client.getOpts().autoReconnect, false);
});

// connectPromise 仍返回本次连接结果；首次失败后，后台重试会在服务器启动时恢复。
test('connectPromise failure automatically recovers when server starts', async context => {
    const { url, port } = await unusedAddress(context);
    const client = createClient(context, { backoff: { baseMs: 100, maxMs: 100, maxRetries: 5 } });
    assert.deepStrictEqual(await client.connectPromise(url), [false, 'error']);
    await client.events.waitForCount('reconnect', 1);
    const { server } = await createLiteServer(context, port);
    await client.events.waitForCount('connect', 1);
    assert(client.isConnected());
    assert.equal(server.clientsNum(), 1);
    assert.equal(client.getRetryCount(), 0);
    assert.equal(client.events.count('connect_fail'), 1);
});

// 非 Promise 的 connect 入口同样可以启动重连，失败次数受 maxRetries 限制。
test('connect also enables automatic retries and reports exhaustion once', async context => {
    const { url } = await unusedAddress(context);
    const client = createClient(context);
    assert(client.connect(url));
    await client.events.waitForCount('retries_exhausted', 1);
    await client.events.waitForCount('close', 3);
    assert.equal(client.events.count('connect_fail'), 3);
    assert.equal(client.events.count('reconnect'), 2);
    assert.equal(client.events.count('reconnect_fail'), 2);
    assert.equal(client.getRetryCount(), 2);
    const count = client.events.entries.length;
    await delay(130);
    assert.equal(client.events.entries.length, count);
});

// 已连接后服务器重启，客户端复用消息处理函数并自动恢复，重试次数在成功后归零。
test('server restart reconnects without losing message handlers', async context => {
    const { server, url, port } = await createLiteServer(context);
    const client = createClient(context, { backoff: { baseMs: 120, maxMs: 120, maxRetries: 5 } });
    const messages: string[] = [];
    client.on('reply', message => messages.push(message));
    assert.deepStrictEqual(await client.connectPromise(url), [true, '']);
    await closeServer(server);
    await client.events.waitForCount('reconnect', 1);
    const restarted = await createLiteServer(context, port);
    await client.events.waitForCount('connect', 2);
    restarted.server.broadcast('reply', 'reconnected');
    await waitUntil(() => messages.length === 1, 'message after reconnect');
    assert.deepStrictEqual(messages, ['reconnected']);
    assert.equal(client.events.count('disconnect'), 1);
    assert.equal(client.getRetryCount(), 0);
    assert.deepStrictEqual(client.events.entries.filter(event => event.event === 'connect').map(event => event.reason), [1, 2]);
});

// error 和随后的 close 只能安排一次重连，不会创建两个并行循环。
test('socket error followed by close starts only one retry loop', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context, { backoff: { baseMs: 100, maxMs: 100 } });
    assert.deepStrictEqual(await client.connectPromise(url), [true, '']);
    const oldSocket = client.ws;
    oldSocket.emit('error', new Error('network failure'));
    assert(!client.isConnected());
    oldSocket.terminate();
    await client.events.waitForCount('connect', 2);
    await delay(130);
    assert.equal(client.events.count('disconnect'), 1);
    assert.equal(client.events.count('reconnect'), 1);
    assert.equal(server.clientsNum(), 1);
});

// 心跳断线也走同一重连流程，而不是仅处理底层 error/close。
test('heartbeat timeout reconnects through the same retry path', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context, { heartbeatInterval: 20, heartbeatTimeout: 100 });
    assert.deepStrictEqual(await client.connectPromise(url), [true, '']);
    server.findById(client.getServerId()).stopPong(true);
    client.lastPong = Date.now() - 200;
    await client.events.waitForCount('connect', 2);
    assert.equal(client.events.count('pong-timeout'), 1);
    assert.equal(client.events.count('disconnect'), 1);
    assert.equal(client.events.count('reconnect'), 1);
    assert(client.isConnected());
});

// 等待协议初始化期间重复连接同一地址，仍共享一个 Promise、一个重试循环。
test('same URL shares the pending promise and zero retries is respected', async context => {
    const { url } = await createStalledServer(context);
    const client = createClient(context, { backoff: { maxRetries: 0 } });
    const first = client.connectPromise(url);
    assert.equal(client.connectPromise(url), first);
    assert.deepStrictEqual(await within(first, 'connection timeout'), [false, 'timeout']);
    await client.events.waitForCount('retries_exhausted', 1);
    assert.equal(client.events.count('reconnect'), 0);
    assert.equal(client.events.count('connect_fail'), 1);
});

// 退避等待中切换 URL，要取消旧循环；已排队的旧等待不能再创建额外连接。
test('switching URL during backoff cancels the previous retry loop', async context => {
    const failed = await unusedAddress(context);
    const { server, url } = await createLiteServer(context);
    const client = createClient(context, { backoff: { baseMs: 100, maxMs: 100 } });
    assert.deepStrictEqual(await client.connectPromise(failed.url), [false, 'error']);
    await client.events.waitForCount('reconnect', 1);
    assert.deepStrictEqual(await client.connectPromise(url), [true, '']);
    await delay(230);
    assert.equal(client.url, url);
    assert.equal(client.events.count('connect'), 1);
    assert.equal(client.events.count('connect_fail'), 1);
    assert.equal(client.events.count('reconnect'), 1);
    assert.equal(server.clientsNum(), 1);
});

// 主动 close 和 destroy 都取消已安排的重试，不因失败状态自动再次启动。
for (const action of ['close', 'destroy'] as const) {
    test(`${action} cancels a scheduled retry`, async context => {
        const { url } = await unusedAddress(context);
        const client = createClient(context, { backoff: { baseMs: 100, maxMs: 100 } });
        await client.connectPromise(url);
        await client.events.waitForCount('close', 1);
        client[action]();
        const count = client.events.entries.length;
        await delay(230);
        assert.equal(client.events.entries.length, count);
        assert.equal(client.events.count('connect_fail'), 1);
        assert.equal(client.events.count('reconnect_fail'), 0);
    });
}

// 已连接时主动 close 不自动恢复，但之后仍能手动 connectPromise，区别于旧包装器的永久 stop。
test('explicit close stops reconnecting but allows a new manual connection', async context => {
    const { url } = await createLiteServer(context);
    const client = createClient(context);
    assert.deepStrictEqual(await client.connectPromise(url), [true, '']);
    client.close();
    await client.events.waitForCount('close', 1);
    await delay(130);
    assert.equal(client.events.count('reconnect'), 0);
    assert.equal(client.events.count('disconnect'), 1);
    assert.deepStrictEqual(await client.connectPromise(url), [true, '']);
    assert.equal(client.events.count('connect'), 2);
});

// 等待握手时 destroy 立即结束原 Promise，也不能留下后台重试。
test('destroy during handshake settles the promise without reconnecting', async context => {
    const { url, sockets } = await createStalledServer(context);
    const client = createClient(context);
    const pending = client.connectPromise(url);
    await waitUntil(() => sockets.size === 1, 'pending handshake');
    client.destroy();
    assert.deepStrictEqual(await within(pending, 'destroyed handshake'), [false, 'destroyed']);
    await delay(130);
    assert.equal(client.events.count('reconnect'), 0);
    assert.equal(client.events.count('connect_fail'), 0);
});

// 允许在 reconnect 通知里关闭客户端；关闭后不能继续等待并建立连接。
test('close inside reconnect callback prevents the retry', async context => {
    const { url } = await unusedAddress(context);
    const client = createClient(context);
    client.onEvent('reconnect', () => client.close());
    assert.deepStrictEqual(await client.connectPromise(url), [false, 'error']);
    await client.events.waitForCount('close', 1);
    await delay(130);
    assert.equal(client.events.count('reconnect'), 1);
    assert.equal(client.events.count('connect_fail'), 1);
    assert.equal(client.events.count('reconnect_fail'), 0);
});
