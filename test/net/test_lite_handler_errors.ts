import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../logger_helpers';
import { IOClient } from '../../src/net/IOClient';
import { IOServer } from '../../src/net/IOServer';
import type { IOServerSocket } from '../../src/net/IOServerSocket';
import { SocketParamEnum } from '../../src/net/msg';
import { NetEventEnum } from '../../src/net/msgid';
import { ErrorEnum } from '../../src/net/ErrorEnum';
import * as logError from '../../src/public/call';
import { createIOPair } from '../io_test_helpers';
import { waitUntil, within } from '../lite_test_helpers';

const messageId = 910004;

async function globalRejectionScenario(direction: string) {
    const logger = createLogger({ silent: true });
    const server = new IOServer('global-rejection-server', logger);
    const client = new IOClient('global-rejection-client', logger, {}, {});
    const expected = new Error(`global rejection: ${direction}`);
    let capture: (reason: unknown) => void;
    const captured = new Promise<unknown>(resolve => { capture = resolve; });
    process.once('unhandledRejection', capture);
    const messages: string[] = [];
    const bad = async () => { throw expected; };
    try {
        if (direction === 'server') {
            server.onMessage(messageId, bad);
            server.onMessage(messageId + 1, () => { messages.push('next'); });
        } else if (direction === 'client') {
            client.onMessage(messageId, bad);
            client.onMessage(messageId + 1, () => { messages.push('next'); });
        } else {
            client.onBroadcast(messageId, bad);
            client.onBroadcast(messageId + 1, () => { messages.push('next'); });
        }
        server.onCallback(messageId + 2, () => [ErrorEnum.ErrorOk, 'healthy']);
        assert.deepStrictEqual(await server.listen('global-rejection-server', 0), [true]);
        assert(await client.connectServer(`ws://127.0.0.1:${server.io.port}`, () => {}));
        if (direction === 'server') {
            client.send([messageId]);
            client.send([messageId + 1]);
        } else {
            const socket = server.findById(client.socket.getServerId());
            const event = direction === 'broadcast' ? NetEventEnum.eventBc : NetEventEnum.eventMod;
            socket.emit(event, [messageId]);
            socket.emit(event, [messageId + 1]);
        }
        assert.equal(await within(captured, 'global rejection captured'), expected);
        await waitUntil(() => messages.length === 1, 'message following rejection');
        assert.deepStrictEqual(await within(client.asend([messageId + 2]), 'RPC after global rejection'),
            [ErrorEnum.ErrorOk, 'healthy']);
        console.log(`GLOBAL_REJECTION_OK:${direction}`);
    } finally {
        process.removeListener('unhandledRejection', capture);
        client.destroy('scenario complete');
        server.close();
        logger.close();
    }
}

if (process.argv[2] === '--global-rejection-fixture') {
    void globalRejectionScenario(process.argv[3]).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
} else {

// 业务同步 throw 或异步 reject 时，沿用旧消息框架的错误码，且后续正常 RPC 不受影响。
for (const kind of ['throw', 'reject'] as const) {
    test(`RPC handler ${kind} returns a defined error and preserves the connection`, async context => {
        const { server, client, connect, logger, errors } = await createIOPair(context);
        context.mock.method(logError, 'logExceptionArgs', (...args: unknown[]) => { logger.error('handler exception', ...args); });
        server.onCallback(messageId, kind === 'throw'
            ? () => { throw new Error('sync failure'); }
            : async () => { throw new Error('async failure'); });
        server.onCallback(messageId + 1, () => [ErrorEnum.ErrorOk, 'healthy']);
        await connect();
        const [code] = await within(client.asend([messageId]), 'handler error result');
        assert.equal(code, kind === 'throw' ? ErrorEnum.Callback_rt_null : ErrorEnum.Callback_await_error);
        assert(errors.length > 0);
        assert.deepStrictEqual(await client.asend([messageId + 1]), [ErrorEnum.ErrorOk, 'healthy']);
        assert.deepStrictEqual(client.callback.callbacks, {});
        assert(client.socket.connected);
    });
}

// 非法 RPC 返回值分别归入空返回或格式错误，不能挂住 Promise，也不能发送非法响应。
for (const result of [undefined, null, 'text', {}, [], ['not-an-error-code']]) {
    test(`invalid RPC handler result is converted to a framework error: ${JSON.stringify(result)}`, async context => {
        const { server, client, connect } = await createIOPair(context);
        server.cbHandle.register(messageId, () => result, null, SocketParamEnum.noSocket, 'invalid-result');
        server.onCallback(messageId + 1, () => [ErrorEnum.ErrorOk, 'healthy']);
        await connect();
        const [code] = await within(client.asend([messageId]), 'invalid handler result');
        assert.equal(code, result == null ? ErrorEnum.Callback_rt_null : ErrorEnum.Callback_rt_invalid);
        assert.deepStrictEqual(await client.asend([messageId + 1]), [ErrorEnum.ErrorOk, 'healthy']);
        assert.deepStrictEqual(client.callback.callbacks, {});
    });
}

// 同步异常沿用旧消息框架的处理机制，不改变已有的日志和后续消息分发行为。
for (const direction of ['server', 'client'] as const) {
    for (const kind of ['throw'] as const) {
        test(`ordinary ${direction} message handler ${kind} is logged and isolated`, async context => {
            const { server, client, connect, peer, logger, errors } = await createIOPair(context);
            context.mock.method(logError, 'logExceptionArgs', (...args: unknown[]) => { logger.error('handler exception', ...args); });
            const bad = kind === 'throw'
                ? () => { throw new Error('sync message failure'); }
                : async () => { throw new Error('async message failure'); };
            const messages: string[] = [];
            if (direction === 'server') {
                server.onMessage(messageId, bad);
                server.onMessage(messageId + 1, (socket: IOServerSocket, data: string) => { messages.push(data); });
            } else {
                client.onMessage(messageId, bad);
                client.onMessage(messageId + 1, (data: string) => { messages.push(data); });
            }
            server.onCallback(messageId + 2, () => [ErrorEnum.ErrorOk, 'healthy']);
            await connect();
            if (direction === 'server') {
                client.send([messageId]);
                client.send([messageId + 1, 'next']);
            } else {
                peer().emit(NetEventEnum.eventMod, [messageId]);
                peer().emit(NetEventEnum.eventMod, [messageId + 1, 'next']);
            }
            await waitUntil(() => messages.length === 1 && errors.length > 0, 'message exception logged');
            assert.deepStrictEqual(messages, ['next']);
            assert.deepStrictEqual(await client.asend([messageId + 2]), [ErrorEnum.ErrorOk, 'healthy']);
            assert(client.socket.connected);
        });
    }
}

// node:test 会将未处理的 rejection 视为失败，因此在独立进程内验证应用的真实全局捕获入口。
for (const direction of ['server', 'client', 'broadcast']) {
    test(`ordinary ${direction} async errors reach the application global rejection handler`, async () => {
        const run = promisify(execFile);
        const { stdout } = await run(process.execPath,
            [__filename, '--global-rejection-fixture', direction],
            { timeout: 30000, windowsHide: true });
        assert(stdout.includes(`GLOBAL_REJECTION_OK:${direction}`));
    });
}
}
