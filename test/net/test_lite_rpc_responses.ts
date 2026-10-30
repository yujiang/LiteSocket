import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IOServerSocket } from '../../src/net/IOServerSocket';
import { NetEventEnum } from '../../src/net/msgid';
import { ErrorEnum, FirstErrorRt } from '../../src/net/ErrorEnum';
import { createIOPair, deferred } from '../io_test_helpers';
import { waitUntil, within } from '../lite_test_helpers';

const messageId = 910002;

// 已完成 session 再次收到响应时，不能重复执行回调、增加成功计数或影响下一次正常请求。
test('duplicate replies are ignored after a request is completed', async context => {
    const { server, client, connect, peer, barrier, errors } = await createIOPair(context);
    server.onCallback(messageId, (socket: IOServerSocket, value: string) => [ErrorEnum.ErrorOk, value]);
    await connect();
    const session = client.callback.session;
    assert.deepStrictEqual(await client.asend([messageId, 'first']), [ErrorEnum.ErrorOk, 'first']);
    peer().emit(NetEventEnum.eventCallbacked, [session, [ErrorEnum.ErrorOk, 'duplicate']]);
    await barrier();
    assert.equal(client.callback.callbacked, 1);
    assert.equal(errors.length, 1);
    assert.deepStrictEqual(client.callback.callbacks, {});
    assert.deepStrictEqual(await client.asend([messageId, 'next']), [ErrorEnum.ErrorOk, 'next']);
    assert.equal(client.callback.callbacked, 2);
});

// 未知 session 的响应只能被记录，不能消耗当前正在等待响应的真实请求。
test('unknown session replies cannot complete a pending request', async context => {
    const { server, client, connect, peer, barrier, errors } = await createIOPair(context);
    const reply = deferred<FirstErrorRt>();
    server.onCallback(messageId, () => reply.promise);
    await connect();
    let completed = false;
    const pending = client.asend([messageId]).then(result => { completed = true; return result; });
    peer().emit(NetEventEnum.eventCallbacked, [999999, [ErrorEnum.ErrorOk, 'unknown']]);
    await barrier();
    assert.equal(completed, false);
    assert.equal(errors.length, 1);
    assert.equal(Object.keys(client.callback.callbacks).length, 1);
    reply.resolve([ErrorEnum.ErrorOk, 'real']);
    assert.deepStrictEqual(await within(pending, 'real response'), [ErrorEnum.ErrorOk, 'real']);
});

// 请求超时后才到达的旧响应不能完成新请求；同一连接的新请求必须继续使用不同的 session。
test('late replies after timeout cannot overwrite the next request', async context => {
    const { server, client, connect, errors } = await createIOPair(context);
    const replies = new Map<string, ReturnType<typeof deferred<FirstErrorRt>>>();
    server.onCallback(messageId, (socket: IOServerSocket, name: string) => {
        const reply = deferred<FirstErrorRt>();
        replies.set(name, reply);
        return reply.promise;
    });
    await connect();
    const oldSession = client.callback.session;
    assert.equal((await within(client.asend([messageId, 'old'], 20), 'expired request'))[0], ErrorEnum.Callback_timeout);
    let completed = false;
    const newSession = client.callback.session;
    const pending = client.asend([messageId, 'new']).then(result => { completed = true; return result; });
    assert.notEqual(oldSession, newSession);
    await waitUntil(() => replies.size === 2, 'old and new request received');
    replies.get('old').resolve([ErrorEnum.ErrorOk, 'too late']);
    await waitUntil(() => errors.length === 1, 'late response rejected');
    assert.equal(completed, false);
    assert.deepStrictEqual(Object.keys(client.callback.callbacks), [String(newSession)]);
    replies.get('new').resolve([ErrorEnum.ErrorOk, 'new result']);
    assert.deepStrictEqual(await within(pending, 'new request response'), [ErrorEnum.ErrorOk, 'new result']);
    assert.deepStrictEqual(client.callback.callbacks, {});
});

// 新连接建立后，旧连接才完成的业务请求不能把旧 session 的结果交给新连接。
test('old connection responses do not reach a replacement connection', async context => {
    const { server, client, connect, url } = await createIOPair(context);
    const replies = new Map<string, ReturnType<typeof deferred<FirstErrorRt>>>();
    server.onCallback(messageId, (socket: IOServerSocket, name: string) => {
        const reply = deferred<FirstErrorRt>();
        replies.set(name, reply);
        return reply.promise;
    });
    await connect();
    const old = client.asend([messageId, 'old']);
    await waitUntil(() => replies.has('old'), 'old request received');
    assert((await client.connectServer(url, () => {}))[0]);
    assert.equal((await within(old, 'old request disconnected'))[0], ErrorEnum.Callback_disconnect);
    const current = client.asend([messageId, 'new']);
    await waitUntil(() => replies.has('new'), 'new request received');
    replies.get('old').resolve([ErrorEnum.ErrorOk, 'old result']);
    replies.get('new').resolve([ErrorEnum.ErrorOk, 'new result']);
    assert.deepStrictEqual(await within(current, 'replacement response'), [ErrorEnum.ErrorOk, 'new result']);
});
