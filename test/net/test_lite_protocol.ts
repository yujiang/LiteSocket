// 使用net/lite模块, 测试protocol
// 1. 包的大小：双向发送和接收分别使用 maxSendLen、maxRecvLen
// a. client发不出去, b. server收到丢弃并报错
// 2. ping-pong 超时
// 3. 发送了不能JSON序列化的数据

import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LiteServerClient } from '../../src/net/LiteServerClient';
import {
    BroadcastExceptionDetails, LiteOptionsInput, msgJsonParseError, msgJsonStringError,
    msgRecvMax, msgSendMax,
} from '../../src/net/LiteNet';
import { LiteSocket } from '../../src/net/LiteSocket';
import { LiteClient, LiteClientOptionsInput } from '../../src/net/LiteClient';
import { connect, createClient, createLiteServer, waitUntil } from '../lite_test_helpers';

// 使用较小的上限方便构造边界包；当前实现比较 JSON 字符串的 length，测试包用 ASCII 控制长度。
const maxSendLen = 1024;
const maxRecvLen = 256;

test('wire format uses e/d while preserving nested numeric message arrays', () => {
    const packet = { e: 'mod', d: [910204, '中文', { nested: [1, 2] }] };
    assert.equal(LiteSocket.encodeMessage(packet.e, packet.d), JSON.stringify(packet));
    assert.deepStrictEqual(LiteSocket.decodeMessage(JSON.stringify(packet)), packet);
});

test('custom event names do not accidentally invoke Object.prototype properties', async context => {
    const { server, client, peer, serverMessages, clientMessages } = await createConnection(context);
    client.emit('__proto__', 'unregistered');
    peer.emit('__proto__', 'unregistered');
    client.emit('payload', 'barrier');
    peer.emit('payload', 'barrier');
    await waitUntil(() => serverMessages.length === 1 && clientMessages.length === 1, 'unknown event barrier');
    const received: string[] = [];
    server.onMessage('__proto__', (_socket, data) => received.push(`server:${data}`));
    client.on('__proto__', data => received.push(`client:${data}`));
    client.emit('__proto__', 'registered');
    peer.emit('__proto__', 'registered');
    await waitUntil(() => received.length === 2, 'custom prototype names');
    assert.deepStrictEqual(received.sort(), ['client:registered', 'server:registered']);
    assert(client.connected && peer.connected);
});

// 建立一对真实连接，等待 system 消息，并分别记录两端的网络事件和 payload 业务消息。
// client 是主动连接的客户端，peer 是服务器内部对应的 LiteClient；测试结束会自动清理。
async function createConnection(
    context: TestContext,
    serverOptions: LiteOptionsInput = {},
    clientOptions: LiteClientOptionsInput = {},
) {
    const { server, url } = await createLiteServer(context, 0, { maxSendLen, maxRecvLen, ...serverOptions });
    const client = createClient(context, clientOptions);
    const clientEvents = client.events.entries;
    const serverEvents = server.events.entries;
    const broadcastExceptions: Array<{ reason: string, details: BroadcastExceptionDetails }> = [];
    server.onEvent('exception', (reason, details) => broadcastExceptions.push({ reason, details }));
    const serverMessages: any[] = [];
    const clientMessages: any[] = [];
    server.onMessage('payload', (peer, data) => serverMessages.push(data));
    client.on('payload', data => clientMessages.push(data));
    await connect(client, url);
    const peer = server.findById(client.getServerId());
    assert(peer);
    assert.deepStrictEqual(client.getSys(), {
        id: peer.id, maxSendLen: server.opts.maxRecvLen, maxRecvLen: server.opts.maxSendLen,
    });
    assert.equal(client.getMaxSendLen(), peer.getMaxRecvLen());
    assert.equal(client.getMaxRecvLen(), peer.getMaxSendLen());
    return { server, client, peer, clientEvents, serverEvents, serverMessages, clientMessages, broadcastExceptions };
}

// packetLength 是整个 JSON 包的长度，包含 eventName、data 等字段，并非仅 payload 的长度。
function sizedPayload(packetLength: number): string {
    const payload = 'x'.repeat(packetLength - LiteSocket.encodeMessage('payload', '').length);
    assert.equal(LiteSocket.encodeMessage('payload', payload).length, packetLength);
    return payload;
}

function assertConnected(client: LiteClient, peer: LiteServerClient) {
    assert(client.isConnected());
    assert(peer.isConnected());
}

// 两端分别发送各种常见数据类型，包括空值、中文、数组和嵌套对象，验证收到的内容及顺序。
// undefined 会在 JSON 中省略 data 字段，接收回调仍应得到 undefined，不能导致异常。
test('JSON payloads round trip in both directions', async context => {
    const { client, peer, serverMessages, clientMessages, clientEvents, serverEvents } = await createConnection(context);
    const payloads = [undefined, null, false, 0, '', '中文🙂', [1, null, 'two'], { nested: { value: true } }];
    for (const payload of payloads) {
        client.emit('payload', payload);
        peer.emit('payload', payload);
    }
    await waitUntil(() => serverMessages.length === payloads.length && clientMessages.length === payloads.length,
        'bidirectional payloads');
    assert.deepStrictEqual(serverMessages, payloads);
    assert.deepStrictEqual(clientMessages, payloads);
    assert.deepStrictEqual(clientEvents.map(entry => entry.event), ['connect']);
    assert.deepStrictEqual(serverEvents.map(entry => entry.event), ['client-connect']);
});

// 分别生成服务端接收上限前一位、恰好等于上限、超过上限的测试；length >= maxRecvLen 就拒绝。
// barrier 是排在待测包后面的正常消息：同一连接按序处理，收到它后即可核对前面的包是否被丢弃。
for (const packetLength of [maxRecvLen - 1, maxRecvLen, maxRecvLen + 1]) {
    // 通过客户端 emit 发送：超限包应在本地被拦截，仅客户端报 msgSendMax，服务端不应收到它。
    test(`client send limit: encoded length ${packetLength}`, async context => {
        const { client, peer, serverMessages, clientEvents, serverEvents } = await createConnection(context);
        const payload = sizedPayload(packetLength);
        client.emit('payload', payload);
        client.emit('payload', 'barrier');
        const allowed = packetLength < maxRecvLen;
        await waitUntil(() => serverMessages.includes('barrier'), 'message after size check');
        assert.deepStrictEqual(serverMessages, allowed ? [payload, 'barrier'] : ['barrier']);
        assert.deepStrictEqual(clientEvents.filter(entry => entry.event === 'exception').map(entry => entry.reason),
            allowed ? [] : [msgSendMax]);
        assert.equal(serverEvents.filter(entry => entry.event === 'exception').length, 0);
        assertConnected(client, peer);
    });

    // 通过 wsSend 绕过客户端检查，验证服务端仍会独立拒收超限包，并报告 msgRecvMax。
    // 两组边界测试都要求后续正常消息仍能到达，不能因为超限而损坏连接。
    test(`server receive limit after raw send: encoded length ${packetLength}`, async context => {
        const { client, peer, serverMessages, clientEvents, serverEvents } = await createConnection(context);
        const payload = sizedPayload(packetLength);
        client.wsSend(LiteSocket.encodeMessage('payload', payload));
        client.emit('payload', 'barrier');
        const allowed = packetLength < maxRecvLen;
        await waitUntil(() => serverMessages.includes('barrier'), 'message after raw size check');
        assert.deepStrictEqual(serverMessages, allowed ? [payload, 'barrier'] : ['barrier']);
        assert.deepStrictEqual(serverEvents.filter(entry => entry.event === 'exception').map(entry => entry.reason),
            allowed ? [] : [msgRecvMax]);
        assert.equal(clientEvents.filter(entry => entry.event === 'exception').length, 0);
        assertConnected(client, peer);
    });
}

// 服务端发送比自身接收上限更大的包，只要低于自身发送上限，客户端就应正常接收。
// 使用普通 emit 即可发送，验证两个方向的限制独立生效，而不是仍共用较小的上限。
test('server can send packets larger than its receive limit', async context => {
    const { client, peer, clientMessages, clientEvents } = await createConnection(context);
    const payload = sizedPayload(maxRecvLen * 3);
    peer.emit('payload', payload);
    peer.emit('payload', 'barrier');
    await waitUntil(() => clientMessages.includes('barrier'), 'large server packet');
    assert.deepStrictEqual(clientMessages, [payload, 'barrier']);
    assert.equal(clientEvents.filter(entry => entry.event === 'exception').length, 0);
    assertConnected(client, peer);
});

// 未指定限制时，两端收发默认都是 1MB，system 下发的配置也必须一致。
test('send and receive limits default to one megabyte', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    assert.equal(client.getMaxSendLen(), 1024 * 1024);
    assert.equal(client.getMaxRecvLen(), 1024 * 1024);
    await connect(client, url);
    const peer = server.findById(client.getServerId());
    assert(peer);
    assert.equal(server.opts.maxSendLen, 1024 * 1024);
    assert.equal(server.opts.maxRecvLen, 1024 * 1024);
    assert.equal(peer.getMaxSendLen(), 1024 * 1024);
    assert.equal(peer.getMaxRecvLen(), 1024 * 1024);
    assert.deepStrictEqual(client.getSys(), {
        id: peer.id, maxSendLen: 1024 * 1024, maxRecvLen: 1024 * 1024,
    });
});

// 把上行限制设得比下行大，验证 system 中的收发方向确实互换，而不是碰巧使用了较大值。
// 同样一个包应能由客户端上行，却会被服务端的下行发送检查拦住。
test('larger upstream limit does not increase the downstream limit', async context => {
    const { client, peer, serverMessages, clientMessages, serverEvents, clientEvents } = await createConnection(context, {
        maxSendLen: maxRecvLen, maxRecvLen: maxSendLen,
    });
    const payload = sizedPayload(maxRecvLen * 3);
    client.emit('payload', payload);
    peer.emit('payload', payload);
    peer.emit('payload', 'barrier');
    await waitUntil(() => serverMessages.length === 1 && clientMessages.includes('barrier'), 'independent upstream limit');
    assert.deepStrictEqual(serverMessages, [payload]);
    assert.deepStrictEqual(clientMessages, ['barrier']);
    assert.deepStrictEqual(serverEvents.filter(entry => entry.event === 'exception').map(entry => entry.reason), [msgSendMax]);
    assert.equal(clientEvents.filter(entry => entry.event === 'exception').length, 0);
    assertConnected(client, peer);
});

for (const packetLength of [maxSendLen - 1, maxSendLen, maxSendLen + 1]) {
    // 服务端普通发送使用自己的 maxSendLen；不能误用更小的 maxRecvLen。
    // 恰好等于发送上限时也必须拒绝，发送失败只通知发送方，后续正常消息仍可到达。
    test(`server send limit: encoded length ${packetLength}`, async context => {
        const { client, peer, clientMessages, clientEvents, serverEvents } = await createConnection(context);
        const payload = sizedPayload(packetLength);
        peer.emit('payload', payload);
        peer.emit('payload', 'barrier');
        const allowed = packetLength < maxSendLen;
        await waitUntil(() => clientMessages.includes('barrier'), 'message after server send check');
        assert.deepStrictEqual(clientMessages, allowed ? [payload, 'barrier'] : ['barrier']);
        assert.deepStrictEqual(serverEvents.filter(entry => entry.event === 'exception').map(entry => entry.reason),
            allowed ? [] : [msgSendMax]);
        assert.equal(clientEvents.filter(entry => entry.event === 'exception').length, 0);
        assertConnected(client, peer);
    });

    // 原始发送绕过服务端发送检查，客户端仍需根据 system 告知的 maxRecvLen 独立拒收。
    // 客户端的接收上限对应服务端发送上限，与客户端较小的发送上限无关。
    test(`client receive limit after raw send: encoded length ${packetLength}`, async context => {
        const { client, peer, clientMessages, clientEvents, serverEvents } = await createConnection(context);
        const payload = sizedPayload(packetLength);
        peer.wsSend(LiteSocket.encodeMessage('payload', payload));
        peer.emit('payload', 'barrier');
        const allowed = packetLength < maxSendLen;
        await waitUntil(() => clientMessages.includes('barrier'), 'message after client receive check');
        assert.deepStrictEqual(clientMessages, allowed ? [payload, 'barrier'] : ['barrier']);
        assert.deepStrictEqual(clientEvents.filter(entry => entry.event === 'exception').map(entry => entry.reason),
            allowed ? [] : [msgRecvMax]);
        assert.equal(serverEvents.filter(entry => entry.event === 'exception').length, 0);
        assertConnected(client, peer);
    });

    for (const target of ['server', 'room'] as const) {
        // 全服广播和房间广播都应使用服务端发送上限，并与 emit 一样拒绝恰好等于上限的包。
        // 低于发送上限但超过接收上限的包必须允许下发，证明广播没有误用 maxRecvLen。
        test(`${target} broadcast send limit: encoded length ${packetLength}`, async context => {
            const { server, client, peer, clientMessages, clientEvents, broadcastExceptions } = await createConnection(context);
            server.joinRoom('packet-limits', peer);
            const room = server.getRoom('packet-limits');
            assert(room);
            const send = (data: [number, string]) => target === 'server'
                ? server.broadcast('payload', data) : room.broadcast('payload', data);
            const payload: [number, string] = [1, 'x'.repeat(packetLength - LiteSocket.encodeMessage('payload', [1, '']).length)];
            assert.equal(LiteSocket.encodeMessage('payload', payload).length, packetLength);
            const barrier: [number, string] = [1, 'barrier'];
            send(payload);
            send(barrier);
            await waitUntil(() => clientMessages.some(data => data[1] === 'barrier'), 'message after broadcast size check');
            assert.deepStrictEqual(clientMessages, packetLength < maxSendLen ? [payload, barrier] : [barrier]);
            assert.equal(clientEvents.filter(entry => entry.event === 'exception').length, 0);
            assert.deepStrictEqual(broadcastExceptions, packetLength < maxSendLen ? [] : [{
                reason: msgSendMax,
                details: {
                    eventName: 'payload', limit: maxSendLen, length: packetLength,
                    ...(target === 'room' ? { room: 'packet-limits' } : {}),
                },
            }]);
            assertConnected(client, peer);
        });
    }
}

for (const target of ['server', 'room'] as const) {
    for (const kind of ['oversized', 'circular', 'bigint'] as const) {
        // 向三个客户端广播超限包、循环引用或 BigInt：一次广播只通知服务端一次 exception。
        // 异常要包含事件名、上限及房间名，不能抛出序列化异常，也不能影响之后的正常广播。
        test(`${target} broadcast reports ${kind} once for multiple recipients`, async context => {
            const { server, client, peer, clientMessages, broadcastExceptions, serverEvents } = await createConnection(context);
            const otherClients = [createClient(context), createClient(context)];
            const otherMessages: string[][] = otherClients.map((): string[] => []);
            for (const [index, other] of otherClients.entries()) {
                other.on('payload', data => otherMessages[index].push(data));
                await connect(other, client.url);
            }
            server.joinRoom('broadcast-errors', peer);
            for (const other of otherClients) server.joinRoom('broadcast-errors', server.findById(other.getServerId()));
            const room = server.getRoom('broadcast-errors');
            const send = (data: any) => target === 'server'
                ? server.broadcast('payload', data) : room.broadcast('payload', data);
            const circular: { self?: any } = {};
            circular.self = circular;
            const data = kind === 'oversized' ? sizedPayload(maxSendLen)
                : kind === 'circular' ? circular : BigInt(1);
            assert.doesNotThrow(() => send(data));
            send('barrier');
            await waitUntil(() => clientMessages.length === 1 && otherMessages.every(messages => messages.length === 1),
                'broadcast after failure');
            assert.deepStrictEqual(clientMessages, ['barrier']);
            assert.deepStrictEqual(otherMessages, [['barrier'], ['barrier']]);
            assert.equal(broadcastExceptions.length, 1);
            const { reason, details } = broadcastExceptions[0];
            assert.equal(reason, kind === 'oversized' ? msgSendMax : msgJsonStringError);
            assert.equal(details.eventName, 'payload');
            assert.equal(details.limit, maxSendLen);
            assert.equal(details.room, target === 'room' ? 'broadcast-errors' : undefined);
            if (kind === 'oversized') assert.equal(details.length, maxSendLen);
            else assert(details.error instanceof Error);
            assert.equal(serverEvents.filter(entry => entry.event === 'exception').length, 0);
            assertConnected(client, peer);
        });
    }
}

for (const direction of ['client-to-server', 'server-to-client'] as const) {
    // 分别向服务端、客户端发送无法 JSON.parse 的文本，接收方应报告 msgJsonParseError 并丢包。
    // 随后发送正常的 barrier，确认解析失败不会断开连接或阻断后续消息。
    test(`invalid JSON is rejected and later messages still arrive: ${direction}`, async context => {
        const connection = await createConnection(context);
        const toServer = direction === 'client-to-server';
        const sender = toServer ? connection.client : connection.peer;
        const messages = toServer ? connection.serverMessages : connection.clientMessages;
        const events = toServer ? connection.serverEvents : connection.clientEvents;
        sender.wsSend('{invalid JSON');
        sender.emit('payload', 'barrier');
        await waitUntil(() => messages.includes('barrier'), 'message after invalid JSON');
        assert.deepStrictEqual(messages, ['barrier']);
        assert.deepStrictEqual(events.filter(entry => entry.event === 'exception').map(entry => entry.reason),
            [msgJsonParseError]);
        assertConnected(connection.client, connection.peer);
    });

    for (const kind of ['circular', 'bigint'] as const) {
        // 两个方向分别尝试发送循环引用对象和 BigInt，它们都会使 JSON.stringify 失败。
        // emit 不应把异常抛给调用者；应由发送方报告 msgJsonStringError，接收方只收到后续正常消息。
        test(`unserializable ${kind} is rejected without sending: ${direction}`, async context => {
            const connection = await createConnection(context);
            const toServer = direction === 'client-to-server';
            const sender = toServer ? connection.client : connection.peer;
            const messages = toServer ? connection.serverMessages : connection.clientMessages;
            const events = toServer ? connection.clientEvents : connection.serverEvents;
            const circular: { self?: any } = {};
            circular.self = circular;
            assert.doesNotThrow(() => sender.emit('payload', kind === 'circular' ? circular : BigInt(1)));
            sender.emit('payload', 'barrier');
            await waitUntil(() => messages.includes('barrier'), 'message after serialization failure');
            assert.deepStrictEqual(messages, ['barrier']);
            assert.deepStrictEqual(events.filter(entry => entry.event === 'exception').map(entry => entry.reason),
                [msgJsonStringError]);
            assertConnected(connection.client, connection.peer);
        });
    }
}

// 两端各发送一个空 WebSocket 消息，接收方应直接忽略，不调用业务回调，也不报告协议异常。
// 再发送正常消息，验证空消息没有影响后续收发。
test('empty frames are ignored in both directions', async context => {
    const { client, peer, serverMessages, clientMessages, clientEvents, serverEvents } = await createConnection(context);
    client.wsSend('');
    peer.wsSend('');
    client.emit('payload', 'barrier');
    peer.emit('payload', 'barrier');
    await waitUntil(() => serverMessages.length === 1 && clientMessages.length === 1, 'messages after empty frames');
    assert.deepStrictEqual(serverMessages, ['barrier']);
    assert.deepStrictEqual(clientMessages, ['barrier']);
    assert.equal(clientEvents.filter(entry => entry.event === 'exception').length, 0);
    assert.equal(serverEvents.filter(entry => entry.event === 'exception').length, 0);
});

// 两端每 25ms 发起心跳，超过 400ms 收不到 pong 才会断线；先确认双方都更新过 lastPong。
// 再运行 900ms，超过两轮超时时间仍应保持连接；ping/pong 必须由内部处理，不能流入业务回调。
test('bidirectional heartbeat stays connected and does not reach application handlers', async context => {
    const options = { heartbeatInterval: 25, heartbeatTimeout: 400 };
    const { client, peer, server, clientEvents, serverEvents } = await createConnection(context, options, options);
    let applicationMessages = 0;
    for (const event of ['ping', 'pong']) {
        client.on(event, () => applicationMessages++);
        server.onMessage(event, () => applicationMessages++);
    }
    const clientLastPong = client.lastPong;
    const serverLastPong = peer.lastPong;
    await waitUntil(() => client.lastPong > clientLastPong && peer.lastPong > serverLastPong, 'both sides receive pong');
    await delay(900);
    assertConnected(client, peer);
    assert(performance.now() - client.lastPong < options.heartbeatTimeout);
    assert(performance.now() - peer.lastPong < options.heartbeatTimeout);
    assert(Number.isFinite(client.getArgDelay()) && client.getArgDelay() >= 0);
    assert(Number.isFinite(peer.getArgDelay()) && peer.getArgDelay() >= 0);
    assert.equal(applicationMessages, 0);
    assert.deepStrictEqual(clientEvents.map(entry => entry.event), ['connect']);
    assert.deepStrictEqual(serverEvents.map(entry => entry.event), ['client-connect']);
});

for (const detector of ['server', 'client'] as const) {
    // 分别验证服务器检测超时、客户端检测超时：让对端 stopPong(true)，停止回复应用层 pong。
    // 检测方用 200ms 超时，另一方用 3000ms，避免双方抢先超时而使断开原因不确定。
    test(`${detector} detects missing pong and disconnects exactly once`, async context => {
        const fast = { heartbeatInterval: 25, heartbeatTimeout: 200 };
        const slow = { heartbeatInterval: 25, heartbeatTimeout: 3000 };
        const { server, client, peer, clientEvents, serverEvents } = await createConnection(context,
            detector === 'server' ? fast : slow, detector === 'client' ? fast : slow);
        const silent = detector === 'server' ? client : peer;
        silent.stopPong(true);
        await waitUntil(() => clientEvents.some(entry => entry.event === 'close') &&
            serverEvents.some(entry => entry.event === 'client-close'), 'heartbeat timeout and close');
        // 检测方先发 disconnect，再发 pong-timeout，最后 close；另一方只观察到连接关闭。
        assert.deepStrictEqual(clientEvents.map(entry => entry.event), detector === 'client'
            ? ['connect', 'disconnect', 'pong-timeout', 'close'] : ['connect', 'disconnect', 'close']);
        assert.deepStrictEqual(serverEvents.map(entry => entry.event), detector === 'server'
            ? ['client-connect', 'client-disconnect', 'pong-timeout', 'client-close']
            : ['client-connect', 'client-disconnect', 'client-close']);
        assert.equal(clientEvents.find(entry => entry.event === 'disconnect').reason,
            detector === 'client' ? 'pong-timeout' : 'close');
        assert.equal(serverEvents.find(entry => entry.event === 'client-disconnect').reason,
            detector === 'server' ? 'pong-timeout' : 'close');
        // Node 环境用 terminate 强制断开，不进行正常关闭握手，因此观察到的关闭码是 1006。
        assert.equal(clientEvents.find(entry => entry.event === 'close').err.code, 1006);
        assert(!client.isConnected());
        assert(!peer.isConnected());
        assert.equal(server.clientsNum(), 0);
        const clientCount = clientEvents.length;
        const serverCount = serverEvents.length;
        // 断开后再等几个心跳周期，确认定时器已清理，不会重复报告断开或超时。
        await delay(100);
        assert.equal(clientEvents.length, clientCount);
        assert.equal(serverEvents.length, serverCount);
    });
}
