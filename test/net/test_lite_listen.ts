// 测试 LiteServer 的监听结果，以及 IOServerBase 的端口重试和启动成功后的关闭。

import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '../logger_helpers';
import { IOServerBase } from '../../src/net/IOServer';
import { LiteServer } from '../../src/net/LiteServer';
import { connect, createClient, createLiteServer, waitUntil, within } from '../lite_test_helpers';

function createOwner(context: TestContext) {
    const logger = createLogger({ silent: true });
    const warnings: unknown[][] = [];
    context.mock.method(logger, 'warn', (...args: unknown[]) => {
        warnings.push(args);
        return logger;
    });
    const owner = new IOServerBase('listen-test', logger);
    context.after(() => {
        owner.close();
        logger.close();
    });
    return { owner, warnings };
}

function recordAttempts(context: TestContext) {
    const attempts: LiteServer[] = [];
    const listenPromise = LiteServer.prototype.listenPromise;
    context.mock.method(LiteServer.prototype, 'listenPromise', function(this: LiteServer, port: number) {
        attempts.push(this);
        return listenPromise.call(this, port);
    });
    return attempts;
}

// 构造阶段只保存配置，可以先注册业务处理；显式监听前不能创建 WebSocketServer 或心跳定时器。
// 监听成功后，提前注册的连接事件和消息回调应在第一次连接上生效。
test('construction is idle and handlers can be registered before listening', async context => {
    const intervals = context.mock.method(globalThis, 'setInterval');
    const server = new LiteServer('two-phase', console, { heartbeatInterval: 25 });
    context.after(() => server.close());
    let connected = 0;
    const messages: string[] = [];
    server.onClient('client-connect', () => { connected++; });
    server.onMessage('probe', (peer, data) => messages.push(data));
    await delay(25);
    assert.equal(server.wss, undefined);
    assert.equal(server.clientsNum(), 0);
    assert.equal(intervals.mock.callCount(), 0);
    assert.deepStrictEqual(await within(server.listenPromise(0), 'explicit listen'), [true]);
    assert.equal(intervals.mock.callCount(), 1);
    const client = createClient(context);
    await connect(client, `ws://127.0.0.1:${server.port}`);
    client.emit('probe', 'configured before listening');
    await waitUntil(() => messages.length === 1, 'pre-registered message handler');
    assert.equal(connected, 1);
    assert.deepStrictEqual(messages, ['configured before listening']);
});

// 端口 0 由系统分配；等待一次监听成功后，端口和名称展示更新，并能接收真实连接。
test('listenPromise records the assigned port and accepts connections', async context => {
    const server = new LiteServer('listen-test', console);
    context.after(() => server.close());
    assert.deepStrictEqual(await within(server.listenPromise(0), 'listen success'), [true]);
    assert(server.port > 0);
    assert.equal(server.getNameDisplay(), `listen-test:${server.port}`);
    const client = createClient(context);
    await connect(client, `ws://127.0.0.1:${server.port}`);
});

// 端口已被占用时，不抛出未处理的 error，而是返回带有 EADDRINUSE 的失败结果。
// 失败实例自动关闭，不留下 WebSocketServer 或心跳；已有服务器仍应可以正常接收连接。
test('listenPromise reports EADDRINUSE and cleans the failed instance', async context => {
    const occupied = await createLiteServer(context);
    const intervals = context.mock.method(globalThis, 'setInterval');
    const failed = new LiteServer('occupied', console);
    context.after(() => failed.close());
    const first = failed.listenPromise(occupied.port);
    const [ok, error] = await within(first, 'occupied port failure');
    assert.equal(ok, false);
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(failed.wss, null);
    assert.equal(intervals.mock.callCount(), 0);
    assert.doesNotThrow(() => failed.close());
    await connect(createClient(context), occupied.url);
});

// 显式监听时发生的同步参数错误，也统一转换成 listenPromise 的失败结果，构造阶段不使用端口。
test('listenPromise reports invalid ports without throwing', async context => {
    const server = new LiteServer('invalid-port', console);
    context.after(() => server.close());
    const [ok, error] = await within(server.listenPromise(-1), 'invalid port result');
    assert.equal(ok, false);
    assert.equal(error.code, 'ERR_SOCKET_BAD_PORT');
    assert.doesNotThrow(() => server.close());
});

// 启动成功后的监听器错误仍有日志入口，不改变已经完成的监听结果或阻断后续连接。
test('runtime listener errors are logged after listening succeeds', async context => {
    const { server, url } = await createLiteServer(context);
    const errors = context.mock.method(console, 'error', () => {});
    const error = new Error('runtime listener failure');
    assert.doesNotThrow(() => server.wss.emit('error', error));
    assert.equal(errors.mock.callCount(), 1);
    assert.equal(errors.mock.calls[0].arguments[1], error);
    await connect(createClient(context), url);
});

// 适配层直接 await LiteServer 的监听结果，成功后才公布 io，并能接收真实客户端。
test('IOServerBase publishes io after successful listening', async context => {
    const { owner } = createOwner(context);
    const listening = owner.listen('io-success', 0, { maxRecvLen: 256 });
    assert.equal(owner.io, undefined);
    assert.deepStrictEqual(await within(listening, 'IO server listening'), [true]);
    assert.equal(owner.io.name, 'io-success');
    assert(owner.io.port > 0);
    const client = createClient(context);
    await connect(client, `ws://127.0.0.1:${owner.io.port}`);
    assert.equal(client.getMaxSendLen(), 256);
});

// 持续占用端口，确认重试次数递增到 1、2；释放端口后，下一次重试应成功且旧失败实例均已清理。
test('IOServerBase retries occupied ports until released', async context => {
    const occupied = await createLiteServer(context);
    const { owner, warnings } = createOwner(context);
    const attempts = recordAttempts(context);
    const listening = owner.listen('io-retry', occupied.port);
    context.after(async () => {
        occupied.server.close();
        await within(listening, 'finish listening before cleanup');
        owner.close();
    });
    const retryWarnings = () => warnings.filter(args => String(args[0]).includes('in use'));
    await waitUntil(() => retryWarnings().length >= 2, 'two occupied-port attempts');
    assert.deepStrictEqual(retryWarnings().map(args => args[1]), [1, 2]);
    assert.equal(owner.io, undefined);
    assert(attempts.slice(0, 2).every(server => server.wss === null));
    const socketServer = occupied.server.wss;
    const closed = new Promise<void>(resolve => socketServer.once('close', () => resolve()));
    occupied.server.close();
    await within(closed, 'release occupied port');
    assert.deepStrictEqual(await within(listening, 'retry after port released'), [true]);
    assert.equal(owner.io.port, occupied.port);
    assert.equal(attempts.length, 3);
});

// 非端口占用错误应直接返回，不进入一秒一次的重试循环。
test('IOServerBase does not retry non-EADDRINUSE failures', async context => {
    const { owner, warnings } = createOwner(context);
    const attempts = recordAttempts(context);
    const [ok, error] = await within(owner.listen('invalid', -1), 'non-retryable failure');
    assert.equal(ok, false);
    assert.equal(error.code, 'ERR_SOCKET_BAD_PORT');
    assert.equal(owner.io, undefined);
    assert.equal(attempts.length, 1);
    assert.equal(warnings.filter(args => String(args[0]).includes('in use')).length, 0);
});

// 启动完成后 close 关闭监听器和已连接的客户端，重复 close 不产生额外影响。
test('IOServerBase closes a successfully started server', async context => {
    const { owner } = createOwner(context);
    assert.deepStrictEqual(await within(owner.listen('close-started', 0), 'server started'), [true]);
    const server = owner.io;
    const websocketServer = server.wss;
    const closed = new Promise<void>(resolve => websocketServer.once('close', () => resolve()));
    const client = createClient(context);
    await connect(client, `ws://127.0.0.1:${server.port}`);
    owner.close();
    assert.equal(owner.io, undefined);
    await within(closed, 'started server closed');
    await client.events.waitForCount('close', 1);
    assert.equal(websocketServer.address(), null);
    assert.equal(server.clientsNum(), 0);
    assert.doesNotThrow(() => owner.close());
});
