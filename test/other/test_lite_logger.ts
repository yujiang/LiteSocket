import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LiteServer } from '../../src/net/LiteServer';
import type { LiteLogger } from '../../src/public/log';
import { msgJsonStringError, msgSendMax } from '../../src/net/LiteNet';
import { createIOPair } from '../io_test_helpers';
import { connect, createClient, createLiteServer, waitUntil } from '../lite_test_helpers';

function createTestLogger() {
    const entries: Array<{ level: string, args: unknown[] }> = [];
    const logger: LiteLogger = {
        info: (...args) => { entries.push({ level: 'info', args }); },
        log: (...args) => { entries.push({ level: 'info', args }); },
        warn: (...args) => { entries.push({ level: 'warn', args }); },
        error: (...args) => { entries.push({ level: 'error', args }); },
        debug: (...args) => { entries.push({ level: 'debug', args }); },
    };
    return { logger, entries };
}

// 显式传入 console 时，踢人操作仍留下包含 ID 和原因的日志。
test('LiteServer uses the supplied logger and logs kickoff attempts', context => {
    const warnings = context.mock.method(console, 'warn', () => {});
    const server = new LiteServer('console-logger', console);
    assert.equal(server.logger, console);
    server.kickoff(42, 'admin kick');
    assert.equal(warnings.mock.callCount(), 1);
    const args = warnings.mock.calls[0].arguments;
    assert(String(args[0]).includes('kickoff'));
    assert.deepStrictEqual(args.slice(1), ['id:', 42, 'reason:', 'admin kick']);
});

// 自定义 logger 接收连接、踢人和断线日志；实际踢人操作仍按原流程关闭连接。
test('custom logger receives connection and kickoff logs', async context => {
    const { logger, entries } = createTestLogger();
    const { server, url } = await createLiteServer(context, 0, {}, logger);
    const client = createClient(context);
    await connect(client, url);
    assert.equal(server.logger, logger);
    assert(entries.some(entry => entry.level === 'info' && String(entry.args[0]).includes('onConnect')));
    const id = client.getServerId();
    server.kickoff(id, 'custom reason');
    const kicks = entries.filter(entry => String(entry.args[0]).includes('kickoff'));
    assert.equal(kicks.length, 1);
    assert.equal(kicks[0].level, 'warn');
    assert.deepStrictEqual(kicks[0].args.slice(1), ['id:', id, 'reason:', 'custom reason']);
    await client.events.waitForCount('close', 1);
    await waitUntil(() => !server.findById(id), 'custom logger disconnect cleanup');
    assert(entries.some(entry => entry.level === 'warn' && String(entry.args[0]).includes('client-close')));
});

// 广播超限使用 warn，序列化失败使用 error；日志注入不能影响原有 exception 回调。
test('broadcast failures use the configured logger and still notify exception handlers', () => {
    const { logger, entries } = createTestLogger();
    const server = new LiteServer('broadcast-logger', logger, { maxSendLen: 128 });
    const reasons: string[] = [];
    server.onEvent('exception', reason => { reasons.push(reason); });
    server.broadcast('probe', 'x'.repeat(256));
    const circular: { self?: unknown } = {};
    circular.self = circular;
    server.broadcast('probe', circular);
    assert.deepStrictEqual(reasons, [msgSendMax, msgJsonStringError]);
    assert.deepStrictEqual(entries.map(entry => entry.level), ['warn', 'error']);
    assert.equal(entries[0].args[1], msgSendMax);
    assert.equal(entries[1].args[1], msgJsonStringError);
});

// 重复注册提醒也走注入的 logger，不再额外直接调用 console.warn。
test('registration warnings use the custom logger instead of console', context => {
    const { logger, entries } = createTestLogger();
    const warnings = context.mock.method(console, 'warn', () => {});
    const server = new LiteServer('registration-logger', logger);
    server.onMessage('probe', () => {});
    server.onMessage('probe', () => {});
    server.onClient('client-connect', () => {});
    server.onClient('client-connect', () => {});
    server.onEvent('exception', () => {});
    server.onEvent('exception', () => {});
    assert.equal(entries.length, 3);
    assert(entries.every(entry => entry.level === 'warn'));
    assert.equal(warnings.mock.callCount(), 0);
});

// 监听成功后的运行期错误也使用同一个 logger，不再绕回 console.error。
test('runtime listener errors use the configured logger', async context => {
    const { logger, entries } = createTestLogger();
    const { server } = await createLiteServer(context, 0, {}, logger);
    const error = new Error('listener failed');
    server.wss.emit('error', error);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, 'error');
    assert.equal(entries[0].args[1], error);
});

// IOServer 将现有业务 logger 传给 LiteServer，GM 踢人日志因此也进入应用的日志系统。
test('IOServer shares its application logger with LiteServer', async context => {
    const { server, client, logger, connect: connectClient } = await createIOPair(context);
    await connectClient();
    assert.equal(server.io.logger, logger);
    const warnings = context.mock.method(logger, 'warn');
    const id = client.socket.getServerId();
    server.io.kickoff(id, 'application kick');
    const kicks = warnings.mock.calls.filter(call => String(call.arguments[0]).includes('kickoff'));
    assert.equal(kicks.length, 1);
    assert.deepStrictEqual(kicks[0].arguments.slice(1), ['id:', id, 'reason:', 'application kick']);
});
