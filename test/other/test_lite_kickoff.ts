import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SocketCloseCode } from '../../src/net/LiteNet';
import { NetEventEnum } from '../../src/net/msgid';
import { SocketParamEnum } from '../../src/net/msg';
import { ErrorEnum, FirstErrorRt } from '../../src/net/ErrorEnum';
import { createIOPair } from '../io_test_helpers';
import { connect, createClient, createLiteServer, waitUntil, within } from '../lite_test_helpers';

// 按 ID 踢掉指定连接，传递关闭原因并移除房间成员；其他连接仍能接收广播。
test('kickoff disconnects only the selected client and cleans its rooms', async context => {
    const { server, url } = await createLiteServer(context);
    const kicked = createClient(context);
    const other = createClient(context);
    await connect(kicked, url);
    await connect(other, url);
    const id = kicked.getServerId();
    const peer = server.findById(id);
    peer.join('only-kicked');
    peer.join('shared');
    server.findById(other.getServerId()).join('shared');
    server.kickoff(id, 'GM kick');
    await kicked.events.waitForCount('close', 1);
    await waitUntil(() => !server.findById(id), 'kicked client removed');
    assert.equal(kicked.events.count('disconnect'), 1);
    assert.equal(kicked.events.count('connect_fail'), 0);
    const closed = kicked.events.entries.find(entry => entry.event === 'close');
    assert.equal(closed.err.code, SocketCloseCode.disconnect);
    assert.equal(closed.err.reason, 'GM kick');
    assert.equal(server.getRoom('only-kicked'), undefined);
    assert.equal(server.getRoom('shared').has(peer), false);
    assert.equal(server.getRoom('shared').size(), 1);
    assert.equal(server.clientsNum(), 1);
    const messages: string[] = [];
    other.on('probe', data => messages.push(data));
    server.broadcast('probe', 'still connected');
    await waitUntil(() => messages.length === 1, 'other client receives broadcast');
    assert.deepStrictEqual(messages, ['still connected']);
    assert(other.connected);
});

// 找不到 ID 时无操作；连续踢同一连接也只产生一次断线，默认关闭原因是 kickoff。
test('kickoff ignores unknown IDs and repeated calls do not duplicate disconnect', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    assert.doesNotThrow(() => server.kickoff(999999));
    await connect(client, url);
    const id = client.getServerId();
    server.kickoff(id);
    server.kickoff(id);
    await client.events.waitForCount('close', 1);
    await waitUntil(() => server.clientsNum() === 0, 'repeated kick cleanup');
    assert.doesNotThrow(() => server.kickoff(id));
    assert.equal(client.events.count('disconnect'), 1);
    assert.equal(server.events.count('client-disconnect'), 1);
    assert.equal(client.events.entries.find(entry => entry.event === 'close').err.reason, 'kickoff');
});

// IOServer 使用的仍是同一个连接：踢人会通知一次业务断线，并结束客户端和服务端双方的待处理 RPC。
test('kickoff settles pending RPCs in both directions through normal disconnect handling', async context => {
    const { server, client, connect: connectClient, peer } = await createIOPair(context);
    const messageId = 910006;
    let receivedByServer = false;
    let receivedByClient = false;
    let disconnects = 0;
    context.mock.method(server, 'onClientDisconnected', () => { disconnects++; });
    server.onCallback(messageId, () => {
        receivedByServer = true;
        return new Promise<FirstErrorRt>(() => {});
    });
    client.handle.getMsghandleCallback().register(messageId, () => {
        receivedByClient = true;
        return new Promise<FirstErrorRt>(() => {});
    }, null, SocketParamEnum.noSocket, 'pending-client-request');
    await connectClient();
    const socket = peer();
    const callback = client.callback;
    const pendingClient = client.asend([messageId]);
    const pendingServer = socket.session.asendSession(NetEventEnum.eventCallback, [messageId], 0);
    await waitUntil(() => receivedByServer && receivedByClient, 'both pending requests received');
    server.io.kickoff(socket.id);
    const results = await within(Promise.all([pendingClient, pendingServer]), 'pending requests after kick');
    assert(results.every(result => result[0] === ErrorEnum.Callback_disconnect));
    await waitUntil(() => server.io.clientsNum() === 0, 'business connection removed');
    assert.equal(disconnects, 1);
    assert.deepStrictEqual(callback.callbacks, {});
    assert.deepStrictEqual(socket.session.callbacks, {});
});
