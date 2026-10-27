import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IOServerSocket } from '../../src/net/IOServerSocket';
import { SocketParamEnum } from '../../src/net/msg';
import { NetEventEnum } from '../../src/net/msgid';
import { ErrorEnum, FirstErrorRt } from '../../src/net/ErrorEnum';
import { createIOClient, createIOPair, deferred } from '../io_test_helpers';
import { waitUntil, within } from '../lite_test_helpers';

const messageId = 910001;

// 同一连接并发发送三个 RPC，服务端倒序返回；完成顺序可以变化，但结果必须匹配原请求。
test('concurrent RPC replies can arrive in reverse order without mixing results', async context => {
    const { server, client, connect } = await createIOPair(context);
    const pending = new Map<number, ReturnType<typeof deferred<FirstErrorRt>>>();
    server.onCallback(messageId, (socket: IOServerSocket, value: number) => {
        const request = deferred<FirstErrorRt>();
        pending.set(value, request);
        return request.promise;
    });
    await connect();
    const completed: number[] = [];
    const requests = [1, 2, 3].map(value => client.asend([messageId, value]).then(result => {
        completed.push(value);
        return result;
    }));
    await waitUntil(() => pending.size === 3, 'concurrent requests received');
    for (const value of [3, 2, 1]) {
        pending.get(value).resolve([ErrorEnum.ErrorOk, value * 10]);
        await waitUntil(() => completed.includes(value), 'reverse reply received');
    }
    assert.deepStrictEqual(await within(Promise.all(requests), 'all reverse replies'), [[0, 10], [0, 20], [0, 30]]);
    assert.deepStrictEqual(completed, [3, 2, 1]);
    assert.deepStrictEqual(client.callback.callbacks, {});
});

// 并发请求中一个先成功、一个超时、另一个稍后成功，超时检查不能结算其他仍有效的请求。
test('successful and timed-out concurrent requests remain independent', async context => {
    const { server, client, connect } = await createIOPair(context);
    const pending = new Map<number, ReturnType<typeof deferred<FirstErrorRt>>>();
    server.onCallback(messageId, (socket: IOServerSocket, value: number) => {
        const request = deferred<FirstErrorRt>();
        pending.set(value, request);
        return request.promise;
    });
    await connect();
    const first = client.asend([messageId, 1]);
    const expired = client.asend([messageId, 2], 25);
    const last = client.asend([messageId, 3]);
    await waitUntil(() => pending.size === 3, 'mixed requests received');
    pending.get(1).resolve([ErrorEnum.ErrorOk, 'first']);
    assert.deepStrictEqual(await within(first, 'first success'), [ErrorEnum.ErrorOk, 'first']);
    assert.equal((await within(expired, 'middle timeout'))[0], ErrorEnum.Callback_timeout);
    assert.equal(Object.keys(client.callback.callbacks).length, 1);
    pending.get(3).resolve([ErrorEnum.ErrorOk, 'last']);
    assert.deepStrictEqual(await within(last, 'last success'), [ErrorEnum.ErrorOk, 'last']);
    assert.deepStrictEqual(client.callback.callbacks, {});
});

// 两个客户端 session 都从 1 开始，服务端异步交叉返回时仍必须按连接隔离。
test('identical session numbers on different clients do not interfere', async context => {
    const { server, client, connect, logger, url } = await createIOPair(context);
    const other = createIOClient(context, logger);
    const pending = new Map<string, ReturnType<typeof deferred<FirstErrorRt>>>();
    server.onCallback(messageId, (socket: IOServerSocket, value: string) => {
        const request = deferred<FirstErrorRt>();
        pending.set(value, request);
        return request.promise;
    });
    await connect();
    assert(await other.connectServer(url, () => {}));
    const first = client.asend([messageId, 'first']);
    const second = other.asend([messageId, 'second']);
    await waitUntil(() => pending.size === 2, 'both clients received');
    assert.deepStrictEqual(Object.keys(client.callback.callbacks), ['1']);
    assert.deepStrictEqual(Object.keys(other.callback.callbacks), ['1']);
    pending.get('second').resolve([ErrorEnum.ErrorOk, 'second']);
    assert.deepStrictEqual(await within(second, 'second client reply'), [ErrorEnum.ErrorOk, 'second']);
    assert.deepStrictEqual(Object.keys(client.callback.callbacks), ['1']);
    pending.get('first').resolve([ErrorEnum.ErrorOk, 'first']);
    assert.deepStrictEqual(await within(first, 'first client reply'), [ErrorEnum.ErrorOk, 'first']);
});

// 服务端主动向客户端发起多个请求，也必须支持倒序响应，验证 SockWrap 的 session 分发。
test('server-to-client concurrent requests also support out-of-order replies', async context => {
    const { client, connect, peer } = await createIOPair(context);
    const pending = new Map<number, ReturnType<typeof deferred<FirstErrorRt>>>();
    client.handle.getMsghandleCallback().register(messageId, (value: number) => {
        const request = deferred<FirstErrorRt>();
        pending.set(value, request);
        return request.promise;
    }, null, SocketParamEnum.noSocket, 'reverse-server-requests');
    await connect();
    const socket = peer();
    const requests = [1, 2, 3].map(value => socket.cb.asendSession(NetEventEnum.eventCallback, [messageId, value], 0));
    await waitUntil(() => pending.size === 3, 'server requests received');
    for (const value of [3, 2, 1]) pending.get(value).resolve([ErrorEnum.ErrorOk, value]);
    assert.deepStrictEqual(await within(Promise.all(requests), 'server request replies'), [[0, 1], [0, 2], [0, 3]]);
    assert.deepStrictEqual(socket.cb.callbacks, {});
});
