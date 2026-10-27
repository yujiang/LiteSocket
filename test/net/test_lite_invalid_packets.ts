import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { createClient, createLiteServer, connect, waitUntil, within } from '../lite_test_helpers';

const invalidPackets = [
    null, [], 1, 'text', {}, { data: 1 }, { eventName: 1 }, { eventName: '' },
    { eventName: 'system', data: null },
    { eventName: 'system', data: { id: '1', maxSendLen: 256, maxRecvLen: 256 } },
    { eventName: 'system', data: { id: 1, maxSendLen: 0, maxRecvLen: 256 } },
    { eventName: 'system', data: { id: 1, maxSendLen: 256 } },
    { eventName: 'ping', data: null }, { eventName: 'ping', data: 'time' },
    { eventName: 'pong', data: null }, { eventName: 'pong', data: [] },
    { eventName: 'pong', data: [1, 'time'] }, { eventName: 'pong', data: [1, 2, 3] },
];

// JSON 可以解析并不代表是合法协议包；两端都应报告 exception，且不影响紧随其后的正常消息。
for (const direction of ['client-to-server', 'server-to-client'] as const) {
    test(`invalid packet structures are rejected without breaking connection: ${direction}`, async context => {
        const { server, url } = await createLiteServer(context);
        const client = createClient(context);
        const messages: number[] = [];
        server.onMessage('checkpoint', (socket, data) => messages.push(data));
        client.on('checkpoint', data => messages.push(data));
        await connect(client, url);
        const peer = server.findById(client.getServerId());
        const sender = direction === 'client-to-server' ? client : peer;
        const events = direction === 'client-to-server' ? server.events : client.events;
        const system = client.getSys();
        const pong = direction === 'client-to-server' ? peer.lastPong : client.lastPong;
        for (const [index, packet] of invalidPackets.entries()) {
            sender.wsSend(JSON.stringify(packet));
            sender.emit('checkpoint', index);
            await waitUntil(() => messages.length === index + 1, 'message after invalid packet');
            assert.equal(events.count('exception'), index + 1, `packet: ${JSON.stringify(packet)}`);
        }
        assert.deepStrictEqual(messages, invalidPackets.map((packet, index) => index));
        assert(client.connected);
        assert(peer.connected);
        assert.deepStrictEqual(client.getSys(), system);
        assert.equal(direction === 'client-to-server' ? peer.lastPong : client.lastPong, pong);
    });
}

// 第一个 system 如果格式错误，不能提前报告连接成功；后续合法 system 仍能正常完成初始化。
test('invalid initial system packets cannot mark a client as connected', async context => {
    const server = new WebSocketServer({ port: 0 });
    context.after(async () => {
        const closed = once(server, 'close');
        for (const socket of server.clients) socket.terminate();
        server.close();
        await within(closed, 'raw system server cleanup');
    });
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    const client = createClient(context);
    const accepted = once(server, 'connection');
    const connecting = client.connectPromise(`ws://127.0.0.1:${address.port}`);
    const [socket] = await accepted;
    let checkpoint = false;
    client.on('checkpoint', () => { checkpoint = true; });
    socket.send(JSON.stringify({ eventName: 'system', data: null }));
    socket.send(JSON.stringify({ eventName: 'checkpoint' }));
    await waitUntil(() => checkpoint, 'invalid system processed');
    assert.equal(client.connected, false);
    assert.equal(client.getSys(), undefined);
    assert.equal(client.events.count('exception'), 1);
    socket.send(JSON.stringify({ eventName: 'system', data: { id: 7, maxSendLen: 256, maxRecvLen: 256 } }));
    assert.deepStrictEqual(await within(connecting, 'valid system after invalid one'), [true, '']);
    assert.equal(client.getServerId(), 7);
});
