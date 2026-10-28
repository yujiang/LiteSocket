import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IOServerSocket } from '../../src/net/IOServerSocket';
import { NetEventEnum } from '../../src/net/msgid';
import { SocketParamEnum } from '../../src/net/msg';
import { msgJsonStringError, msgSendMax } from '../../src/net/LiteNet';
import { ErrorEnum, FirstErrorRt } from '../../src/net/ErrorEnum';
import { createIOPair, deferred } from '../io_test_helpers';
import { waitUntil, within } from '../lite_test_helpers';

const messageId = 910005;

function invalidPayload(kind: string): unknown {
    if (kind === 'oversized') return 'x'.repeat(512);
    if (kind === 'bigint') return BigInt(1);
    const payload: { self?: unknown } = {};
    payload.self = payload;
    return payload;
}

// 即使不启用超时检查，发送超限或不能序列化也必须立即结束对应 RPC，而不是永久悬挂。
for (const kind of ['oversized', 'circular', 'bigint']) {
    for (const method of ['asend', 'asende'] as const) {
        test(`${method} settles immediately when request encoding fails: ${kind}`, async context => {
            const { server, client, connect, errors } = await createIOPair(context, { checktimeout: false }, { maxRecvLen: 256 });
            const received: unknown[] = [];
            server.onCallback(messageId, (socket: IOServerSocket, data: unknown) => {
                received.push(data);
                return [ErrorEnum.ErrorOk, data];
            });
            await connect();
            const result = await within<FirstErrorRt | ErrorEnum>(client[method]([messageId, invalidPayload(kind)]), 'failed send settled', 300);
            assert.equal(Array.isArray(result) ? result[0] : result, ErrorEnum.settleSendFailure);
            if (Array.isArray(result)) assert.equal(result[1], kind === 'oversized' ? msgSendMax : msgJsonStringError);
            // 底层日志和 IOClient 共用 logger；只统计业务层的 exception 通知。
            assert.equal(errors.filter(args => args[0] === 'IOClient socket exception').length, 1);
            assert.deepStrictEqual(client.callback.callbacks, {});
            assert.deepStrictEqual(await client.asend([messageId, 'healthy']), [ErrorEnum.ErrorOk, 'healthy']);
            assert.deepStrictEqual(received, ['healthy']);
            assert(client.socket.connected);
        });
    }
}

// 一个请求发送失败只能结算自己的 session，不能 reset 掉同一连接上其他已发送的请求。
test('failed send does not cancel another pending request', async context => {
    const { server, client, connect } = await createIOPair(context, { checktimeout: false }, { maxRecvLen: 256 });
    const reply = deferred<FirstErrorRt>();
    let received = false;
    server.onCallback(messageId, () => { received = true; return reply.promise; });
    await connect();
    const pending = client.asend([messageId]);
    await waitUntil(() => received, 'first request received');
    const failed = await within(client.asend([messageId, invalidPayload('oversized')]), 'second send failure', 300);
    assert.equal(failed[0], ErrorEnum.settleSendFailure);
    assert.deepStrictEqual(Object.keys(client.callback.callbacks), ['1']);
    reply.resolve([ErrorEnum.ErrorOk, 'first result']);
    assert.deepStrictEqual(await within(pending, 'first request unaffected'), [ErrorEnum.ErrorOk, 'first result']);
});

// 底层 send 同步抛异常也必须结束请求，恢复底层发送后连接还能继续使用。
test('synchronous WebSocket send errors settle the matching request', async context => {
    const { server, client, connect } = await createIOPair(context, { checktimeout: false });
    server.onCallback(messageId, () => [ErrorEnum.ErrorOk, 'healthy']);
    await connect();
    const socket = client.socket.ws;
    const send = socket.send;
    let fail = true;
    context.mock.method(socket, 'send', (...args: any[]) => {
        if (fail) { fail = false; throw new Error('transport send failed'); }
        return Reflect.apply(send, socket, args);
    });
    assert.equal((await within(client.asend([messageId]), 'transport send failure', 300))[0], ErrorEnum.settleSendFailure);
    assert.deepStrictEqual(client.callback.callbacks, {});
    assert.deepStrictEqual(await client.asend([messageId]), [ErrorEnum.ErrorOk, 'healthy']);
});

// 服务端主动发起 RPC 也应遵守同样的发送失败语义，不能让 SockWrap 中的 Promise 永久等待。
test('server-to-client request send failures also settle without a timeout timer', async context => {
    const { client, connect, peer } = await createIOPair(context, {}, { maxSendLen: 256 });
    client.handle.getMsghandleCallback().register(messageId, () => [ErrorEnum.ErrorOk, 'healthy'],
        null, SocketParamEnum.noSocket, 'server-request');
    await connect();
    const socket = peer();
    const result = await within(socket.session.asendSession(NetEventEnum.eventCallback,
        [messageId, invalidPayload('oversized')], 0), 'server request send failure', 300);
    assert.deepStrictEqual(result, [ErrorEnum.settleSendFailure, msgSendMax]);
    assert.deepStrictEqual(socket.session.callbacks, {});
    assert.deepStrictEqual(await socket.session.asendSession(NetEventEnum.eventCallback, [messageId], 0), [ErrorEnum.ErrorOk, 'healthy']);
});

// 普通 send 没有 RPC session；它发送失败时只能报告 exception，不能误伤其他正在等待的 RPC。
test('ordinary message send failures do not cancel a pending RPC', async context => {
    const { server, client, connect, errors } = await createIOPair(context, { checktimeout: false }, { maxRecvLen: 256 });
    const reply = deferred<FirstErrorRt>();
    let received = false;
    server.onCallback(messageId, () => { received = true; return reply.promise; });
    await connect();
    const pending = client.asend([messageId]);
    await waitUntil(() => received, 'pending request before ordinary send');
    client.send([messageId, invalidPayload('oversized')]);
    assert.equal(errors.filter(args => args[0] === 'IOClient socket exception').length, 1);
    assert.deepStrictEqual(Object.keys(client.callback.callbacks), ['1']);
    reply.resolve([ErrorEnum.ErrorOk, 'not cancelled']);
    assert.deepStrictEqual(await within(pending, 'pending request preserved'), [ErrorEnum.ErrorOk, 'not cancelled']);
});
