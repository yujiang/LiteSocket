// 通过真实的错误处理入口触发 ErrorEnum；Max 仅为自定义错误码边界。
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { msgData } from '../../src/public/Depends';
import { ErrorEnum, FirstErrorRt, getErrorEnumString } from '../../src/net/ErrorEnum';
import { MsgId, NetEventEnum } from '../../src/net/msgid';
import { SocketParamEnum } from '../../src/net/msg';
import { ClientSession } from '../../src/net/ClientSession';
import { msgJsonStringError, msgSendError, msgSendMax } from '../../src/net/LiteNet';
import { createIOClient, createIOPair, deferred } from '../io_test_helpers';
import { createLogger } from '../logger_helpers';
import { waitUntil, within } from '../lite_test_helpers';

const messageId = 920001;
const covered = new Set<ErrorEnum>();

function checkCode(result: FirstErrorRt, expected: ErrorEnum): void {
    assert.equal(result[0], expected, `预期 ${getErrorEnumString(expected)}，实际 ${getErrorEnumString(result[0])}`);
    covered.add(expected);
}

// RPC 错误必须经过消息分发、编码和回调匹配，且不能破坏后续请求。
const cases = [
    { code: ErrorEnum.ErrorOk, setup: 'success' },
    { code: ErrorEnum.ErrorError, setup: 'query' },
    { code: ErrorEnum.Msg_closed, setup: 'closed' },
    { code: ErrorEnum.Handle_not_find, setup: 'missing' },
    { code: ErrorEnum.Callback_filter_null, setup: 'filter' },
    { code: ErrorEnum.Callback_await_error, setup: 'reject' },
    { code: ErrorEnum.Callback_rt_null, setup: 'undefined' },
    { code: ErrorEnum.Callback_rt_null, setup: 'null' },
    { code: ErrorEnum.Callback_rt_null, setup: 'throw' },
    ...['text', 'object', 'empty-array', 'invalid-code'].map(setup => ({
        code: ErrorEnum.Callback_rt_invalid, setup,
    })),
];

for (const { code, setup } of cases) {
    test(`${getErrorEnumString(code)}: ${setup}`, async context => {
        const { server, client, connect } = await createIOPair(context);
        let called = 0;
        const handler = (): FirstErrorRt => { called++; return [ErrorEnum.ErrorOk, 'healthy']; };
        if (setup === 'success' || setup === 'closed') server.onCallback(messageId, handler);
        if (setup === 'closed') server.cbHandle.closeMsg(messageId, true);
        if (setup === 'filter') {
            server.cbHandle.register(messageId, handler, null, () => null, 'reject-filter');
        }
        if (setup === 'reject') server.onCallback(messageId, async () => { throw new Error('async failure'); });
        if (setup === 'throw') server.onCallback(messageId, () => { throw new Error('sync failure'); });
        const invalid: Record<string, unknown> = {
            undefined: undefined, null: null, text: 'invalid', object: {},
            'empty-array': [], 'invalid-code': ['invalid'],
        };
        if (Object.prototype.hasOwnProperty.call(invalid, setup)) {
            server.cbHandle.register(messageId, () => invalid[setup], null, SocketParamEnum.noSocket, setup);
        }
        server.onCallback(messageId + 1, () => [ErrorEnum.ErrorOk, 'next']);
        await connect();
        const request: msgData = setup === 'query' ? [MsgId.MSG_SYSTEM_QUERYHTTPSERVER, 'missing'] : [messageId];
        const result = await within(client.asend(request), setup);
        checkCode(result, code);
        if (setup === 'success') assert.deepStrictEqual(result, [ErrorEnum.ErrorOk, 'healthy']);
        if (setup === 'query') assert.deepStrictEqual(result, [ErrorEnum.ErrorError, 'unknown key missing']);
        if (setup === 'closed' || setup === 'filter') assert.equal(called, 0);
        assert.deepStrictEqual(client.callback.callbacks, {});
        assert.deepStrictEqual(await within(client.asend([messageId + 1]), 'RPC after error'), [ErrorEnum.ErrorOk, 'next']);
        assert(client.socket.connected);
    });
}

test('Net_notconnect: requests before connecting and after closing', async context => {
    const logger = createLogger();
    const idle = createIOClient(context, logger);
    checkCode(await idle.asend([messageId]), ErrorEnum.Net_notconnect);
    assert.equal(await idle.asende([messageId]), ErrorEnum.Net_notconnect);
    const { client, connect } = await createIOPair(context);
    await connect();
    const callback = client.callback;
    client.destroy('manual close');
    checkCode(await client.asend([messageId]), ErrorEnum.Net_notconnect);
    checkCode(await callback.asendSession(NetEventEnum.eventCallback, [messageId], 0), ErrorEnum.Net_notconnect);
    assert.deepStrictEqual(callback.callbacks, {});
});

test('Callback_not_find remains reserved after removal of asendSock', () => {
    assert.equal(getErrorEnumString(ErrorEnum.Callback_not_find), 'Callback_not_find');
});

test('Callback_timeout: unanswered request expires and late reply is ignored', async context => {
    const { server, client, connect, errors } = await createIOPair(context);
    const reply = deferred<FirstErrorRt>();
    context.after(() => reply.resolve([ErrorEnum.ErrorOk, 'cleanup']));
    server.onCallback(messageId, () => reply.promise);
    server.onCallback(messageId + 1, () => [ErrorEnum.ErrorOk, 'next']);
    await connect();
    const result = await within(client.asend([messageId], 20), 'timeout');
    checkCode(result, ErrorEnum.Callback_timeout);
    assert.deepStrictEqual(client.callback.callbacks, {});
    reply.resolve([ErrorEnum.ErrorOk, 'late']);
    await waitUntil(() => errors.some(args => String(args[0]).includes('on_callbacked error id')), 'late reply ignored');
    assert.deepStrictEqual(result, [ErrorEnum.Callback_timeout]);
    assert.deepStrictEqual(await client.asend([messageId + 1]), [ErrorEnum.ErrorOk, 'next']);
});

test('Callback_disconnect: connection loss settles every pending request', async context => {
    const { server, client, connect, peer } = await createIOPair(context, { checktimeout: false });
    const reply = deferred<FirstErrorRt>();
    context.after(() => reply.resolve([ErrorEnum.ErrorOk]));
    let received = 0;
    server.onCallback(messageId, () => { received++; return reply.promise; });
    await connect();
    const callback = client.callback;
    const pending = [client.asend([messageId]), client.asend([messageId])];
    await waitUntil(() => received === 2, 'requests received before disconnect');
    peer().terminate();
    for (const result of await within(Promise.all(pending), 'disconnect settlement')) {
        checkCode(result, ErrorEnum.Callback_disconnect);
    }
    assert.deepStrictEqual(callback.callbacks, {});
    assert(!client.socket?.connected);
});

test('Callback_bindsocket: rebinding settles old sessions before using the new socket', async () => {
    const callback = new ClientSession('rebind-test', createLogger(), null);
    let oldSends = 0;
    let newSends = 0;
    callback.resetSocket({ connected: true, emit() { oldSends++; } });
    const pending = callback.asendMod(NetEventEnum.eventCallback, [messageId]);
    assert.equal(oldSends, 1);
    callback.resetSocket({ connected: true, emit() { newSends++; } });
    checkCode(await within(pending, 'rebind settlement'), ErrorEnum.Callback_bindsocket);
    assert.deepStrictEqual(callback.callbacks, {});
    assert.equal(newSends, 0);
    const next = callback.asendMod(NetEventEnum.eventCallback, [messageId]);
    assert.equal(newSends, 1);
    callback.onCallbacked(1, [ErrorEnum.ErrorOk, 'new socket']);
    assert.deepStrictEqual(await within(next, 'new socket reply'), [ErrorEnum.ErrorOk, 'new socket']);
    assert.deepStrictEqual(callback.callbacks, {});
    callback.close();
});

for (const kind of ['oversized', 'circular', 'bigint', 'transport'] as const) {
    test(`settleSendFailure: ${kind}`, async context => {
        const { server, client, connect } = await createIOPair(context, { checktimeout: false }, { maxRecvLen: 256 });
        server.onCallback(messageId, () => [ErrorEnum.ErrorOk, 'healthy']);
        await connect();
        const circular: { self?: unknown } = {};
        circular.self = circular;
        const payload = kind === 'oversized' ? 'x'.repeat(512) : kind === 'bigint' ? BigInt(1) : circular;
        const send = kind === 'transport'
            ? context.mock.method(client.socket.ws, 'send', () => { throw new Error('transport send failed'); })
            : undefined;
        const result = await within(client.asend(kind === 'transport' ? [messageId] : [messageId, payload]), 'send failure');
        checkCode(result, ErrorEnum.settleSendFailure);
        assert.equal(result[1], kind === 'oversized' ? msgSendMax : kind === 'transport' ? msgSendError : msgJsonStringError);
        assert.deepStrictEqual(client.callback.callbacks, {});
        send?.mock.restore();
        assert.deepStrictEqual(await within(client.asend([messageId]), 'RPC after send failure'), [ErrorEnum.ErrorOk, 'healthy']);
    });
}

test('all active ErrorEnum values were triggered; Max is the custom-code boundary', () => {
    // asendSock 已移除，该错误码保留编号但没有运行时触发入口。
    const runtimeCodes = Object.values(ErrorEnum).filter((value): value is ErrorEnum =>
        typeof value === 'number' && value !== ErrorEnum.Max && value !== ErrorEnum.Callback_not_find);
    assert.deepStrictEqual([...covered].sort((a, b) => a - b), runtimeCodes.sort((a, b) => a - b));
    assert.equal(ErrorEnum.Max, 100);
    assert(runtimeCodes.every(code => code < ErrorEnum.Max));
});
