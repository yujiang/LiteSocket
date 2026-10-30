// 通过实际连接和协议错误触发 LiteClient 的所有 socketClientEvent。
import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LiteClient, LiteClientOptionsInput } from '../../src/net/LiteClient';
import {
    socketClientEvent, SocketCloseCode, msgInvalidPacket, msgJsonParseError,
    msgJsonStringError, msgRecvMax, msgSendError, msgSendMax,
} from '../../src/net/LiteNet';
import {
    createLiteServer, createStalledServer, unusedAddress, waitUntil, within, terminateClient,
} from '../lite_test_helpers';
import { createLogger } from '../logger_helpers';

// Record 保证 socketClientEvent 新增事件时，这里的覆盖清单也必须更新。
const eventTypes: Record<socketClientEvent, true> = {
    connect: true, disconnect: true, connect_fail: true,
    reconnect: true, reconnect_fail: true, retries_exhausted: true,
    'pong-timeout': true, close: true, error: true, exception: true,
};
const observed = new Set<socketClientEvent>();
type Entry = { event: string, reason?: string | number, error?: any };

function watchClient(context: TestContext, opts: LiteClientOptionsInput = {}) {
    const client = new LiteClient('events-test', createLogger(), opts);
    const entries: Entry[] = [];
    const allEntries: Entry[] = [];
    const order: string[] = [];
    for (const event of Object.keys(eventTypes) as socketClientEvent[]) {
        client.onEvent(event, (reason, error) => {
            observed.add(event);
            entries.push({ event, reason, error });
            order.push(`on:${event}`);
        });
    }
    client.allEventFunc = (event: string, reason, error) => {
        allEntries.push({ event, reason, error });
        order.push(`all:${event}`);
    };
    context.after(async () => {
        client.destroy();
        await terminateClient(client);
    });
    const events = (event: socketClientEvent) => entries.filter(entry => entry.event === event);
    const wait = (event: socketClientEvent, count = 1) =>
        waitUntil(() => events(event).length >= count, `${event} count >= ${count}`);
    const consistent = () => {
        assert.deepStrictEqual(allEntries, entries);
        assert.deepStrictEqual(order, entries.flatMap(entry => [`on:${entry.event}`, `all:${entry.event}`]));
    };
    return { client, entries, events, wait, consistent };
}

test('connect, disconnect, close: one notification each in lifecycle order', async context => {
    const { server, url } = await createLiteServer(context, 0, {}, createLogger());
    const watched = watchClient(context);
    const { client, entries, events, wait } = watched;
    assert.deepStrictEqual(await within(client.connectPromise(url), 'connection'), [true, '']);
    assert(client.connected);
    assert(client.getServerId() > 0);
    assert.equal(client.timeoutHandle, null);
    assert.deepStrictEqual(events('connect'), [{ event: 'connect', reason: undefined, error: undefined }]);
    assert.deepStrictEqual(await client.connectPromise(url), [true, 'same url']);
    const peer = server.findById(client.getServerId());
    // 重复 system 和同地址 connect 都不能重复通知 connect。
    peer.emit('system', client.getSys());
    const barrier = new Promise<void>(resolve => client.on('barrier', () => resolve()));
    peer.emit('barrier');
    await within(barrier, 'duplicate system processed');
    assert.equal(events('connect').length, 1);
    peer.close(SocketCloseCode.test, 'server goodbye');
    await wait('close');
    assert.deepStrictEqual(entries.map(entry => entry.event), ['connect', 'disconnect', 'close']);
    assert.equal(events('disconnect')[0].reason, 'close');
    for (const entry of [events('disconnect')[0], events('close')[0]]) {
        assert.equal(entry.error.code, SocketCloseCode.test);
        assert.equal(entry.error.reason, 'server goodbye');
    }
    assert(!client.connected);
    watched.consistent();
});

test('connectPromise invokes its disconnect callback after connection loss', async context => {
    const { server, url } = await createLiteServer(context, 0, {}, createLogger());
    const watched = watchClient(context);
    const disconnects: Array<[string | number, unknown]> = [];
    assert.deepStrictEqual(await within(
        watched.client.connectPromise(url, (reason, error) => { disconnects.push([reason, error]); }),
        'connection',
    ), [true, '']);

    server.findById(watched.client.getServerId()).terminate();
    await watched.wait('disconnect');
    await waitUntil(() => disconnects.length === 1, 'disconnect callback');
    assert.equal(disconnects[0][0], 'close');
    assert.equal(disconnects[0][1], watched.events('disconnect')[0].error);
    assert.deepStrictEqual(disconnects.map(([reason]) => reason), ['close']);
});

test('connect_fail and error: invalid URL fails synchronously without disconnect', async context => {
    const watched = watchClient(context);
    const { client, entries } = watched;
    assert.deepStrictEqual(await client.connectPromise('not-a-websocket-url'), [false, 'error']);
    assert.deepStrictEqual(entries.map(entry => entry.event), ['connect_fail', 'error']);
    assert.equal(entries[0].reason, 'error');
    assert(entries[0].error instanceof Error);
    assert.equal(entries[1].error, entries[0].error);
    assert(!client.connected);
    assert.equal(client.timeoutHandle, null);
    watched.consistent();
});

test('connect_fail, error, close: refused connection reports failure once', async context => {
    const { url } = await unusedAddress(context);
    const watched = watchClient(context);
    assert.deepStrictEqual(await within(watched.client.connectPromise(url), 'refused connection'), [false, 'error']);
    await watched.wait('close');
    assert.deepStrictEqual(watched.entries.map(entry => entry.event), ['connect_fail', 'error', 'close']);
    assert.equal(watched.events('connect_fail')[0].reason, 'error');
    assert.match(watched.events('error')[0].error.message, /ECONNREFUSED/);
    assert.equal(watched.client.timeoutHandle, null);
    watched.consistent();
});

test('connect_fail: handshake timeout has reason timeout and never disconnects', async context => {
    const { url } = await createStalledServer(context);
    const watched = watchClient(context, { connectTimeout: 50 });
    assert.deepStrictEqual(await within(watched.client.connectPromise(url), 'handshake timeout'), [false, 'timeout']);
    await watched.wait('close');
    assert.deepStrictEqual(watched.entries.map(entry => entry.event), ['connect_fail', 'error', 'close']);
    assert.equal(watched.events('connect_fail')[0].reason, 'timeout');
    assert.equal(watched.events('connect_fail')[0].error, undefined);
    assert.equal(watched.client.timeoutHandle, null);
    watched.consistent();
});

test('connected transport error precedes close but disconnect is emitted only once', async context => {
    const { url } = await createLiteServer(context, 0, {}, createLogger());
    const watched = watchClient(context);
    await within(watched.client.connectPromise(url), 'connection');
    const failure = new Error('transport failure');
    // 已连接的本机 socket 很难稳定制造底层错误，通过 ws 的公开事件入口注入。
    watched.client.ws.emit('error', failure);
    assert(!watched.client.connected);
    watched.client.ws.terminate();
    await watched.wait('close');
    assert.deepStrictEqual(watched.entries.map(entry => entry.event), ['connect', 'disconnect', 'error', 'close']);
    assert.equal(watched.events('disconnect')[0].reason, 'error');
    assert.equal(watched.events('error')[0].error.message, failure.message);
    assert.equal(watched.events('disconnect')[0].error, watched.events('error')[0].error);
    watched.consistent();
});

test('pong-timeout: disconnect happens before timeout diagnostics and close', async context => {
    const { server, url } = await createLiteServer(context, 0, {}, createLogger());
    const watched = watchClient(context, { heartbeatInterval: 5, heartbeatTimeout: 50 });
    await within(watched.client.connectPromise(url), 'connection');
    server.findById(watched.client.getServerId()).stopPong(true);
    await watched.wait('close');
    assert.deepStrictEqual(watched.entries.map(entry => entry.event), ['connect', 'disconnect', 'pong-timeout', 'close']);
    assert.equal(watched.events('disconnect')[0].reason, 'pong-timeout');
    assert.equal(watched.events('pong-timeout')[0].reason, undefined);
    assert(!watched.client.connected);
    watched.consistent();
});

test('reconnect, reconnect_fail, retries_exhausted: numbered retries stop at the configured limit', async context => {
    const { url } = await unusedAddress(context);
    const watched = watchClient(context, {
        autoReconnect: true,
        backoff: { baseMs: 10, maxMs: 10, jitter: 0, maxRetries: 2 },
    });
    assert.deepStrictEqual(await within(watched.client.connectPromise(url), 'initial failure'), [false, 'error']);
    await watched.wait('retries_exhausted');
    await watched.wait('close', 3);
    const retryEvents = watched.entries.filter(entry =>
        ['reconnect', 'reconnect_fail', 'retries_exhausted'].includes(entry.event));
    assert.deepStrictEqual(retryEvents.map(({ event, reason }) => [event, reason]), [
        ['reconnect', 1], ['reconnect_fail', 1], ['reconnect', 2], ['reconnect_fail', 2],
        ['retries_exhausted', 'retries_exhausted'],
    ]);
    assert.equal(watched.events('connect_fail').length, 3);
    assert.equal(watched.events('error').length, 3);
    assert.equal(watched.events('disconnect').length, 0);
    assert.equal(watched.client.getRetryCount(), 2);
    const count = watched.entries.length;
    await delay(40);
    assert.equal(watched.entries.length, count);
    watched.consistent();
});

test('reconnect recovers initial failure when the server becomes available', async context => {
    const { url, port } = await unusedAddress(context);
    const watched = watchClient(context, {
        autoReconnect: true,
        backoff: { baseMs: 100, maxMs: 100, jitter: 0, maxRetries: 3 },
    });
    assert.deepStrictEqual(await within(watched.client.connectPromise(url), 'initial failure'), [false, 'error']);
    await createLiteServer(context, port, {}, createLogger());
    await watched.wait('connect');
    assert.equal(watched.events('connect')[0].reason, 1);
    assert.equal(watched.events('reconnect')[0].reason, 1);
    assert.equal(watched.events('reconnect_fail').length, 0);
    assert.equal(watched.events('retries_exhausted').length, 0);
    assert.equal(watched.client.getRetryCount(), 0);
    assert(watched.client.connected);
    watched.consistent();
});

test('automatic reconnection numbers successful connections and preserves message handlers', async context => {
    const { server, url } = await createLiteServer(context, 0, {}, createLogger());
    const watched = watchClient(context, {
        autoReconnect: true,
        backoff: { baseMs: 10, maxMs: 10, jitter: 0, maxRetries: 2 },
    });
    const messages: string[] = [];
    watched.client.on('healthy', data => { messages.push(data); });
    await within(watched.client.connectPromise(url), 'initial connection');
    server.findById(watched.client.getServerId()).terminate();
    await watched.wait('connect', 2);
    assert.deepStrictEqual(watched.events('connect').map(entry => entry.reason), [1, 2]);
    assert.equal(watched.events('disconnect').length, 1);
    assert.equal(watched.events('reconnect').length, 1);
    assert.equal(watched.events('connect_fail').length, 0);
    server.findById(watched.client.getServerId()).emit('healthy', 'after reconnect');
    await waitUntil(() => messages.length === 1, 'message after reconnect');
    assert.deepStrictEqual(messages, ['after reconnect']);
    watched.consistent();
});

const exceptionCases = [
    { kind: 'oversized-send', reason: msgSendMax },
    { kind: 'circular', reason: msgJsonStringError },
    { kind: 'transport', reason: msgSendError },
    { kind: 'invalid-json', reason: msgJsonParseError },
    { kind: 'invalid-packet', reason: msgInvalidPacket },
    { kind: 'oversized-receive', reason: msgRecvMax },
];
for (const { kind, reason } of exceptionCases) {
    test(`exception: ${kind} reports details and leaves the connection usable`, async context => {
        const { server, url } = await createLiteServer(context, 0, { maxRecvLen: 256, maxSendLen: 256 }, createLogger());
        const watched = watchClient(context);
        const { client } = watched;
        await within(client.connectPromise(url), 'connection');
        const peer = server.findById(client.getServerId());
        const circular: { self?: unknown } = {};
        circular.self = circular;
        let send: ReturnType<typeof context.mock.method> | undefined;
        switch (kind) {
            case 'oversized-send': client.emit('probe', 'x'.repeat(512)); break;
            case 'circular': client.emit('probe', circular); break;
            case 'transport':
                send = context.mock.method(client.ws, 'send', () => { throw new Error('send failure'); });
                client.emit('probe', 'payload');
                send.mock.restore();
                break;
            case 'invalid-json': peer.ws.send('{invalid'); break;
            case 'invalid-packet': peer.ws.send(JSON.stringify({ eventName: '' })); break;
            case 'oversized-receive': peer.ws.send('x'.repeat(512)); break;
        }
        await watched.wait('exception');
        const exception = watched.events('exception')[0];
        assert.equal(exception.reason, reason);
        if (['oversized-send', 'circular', 'transport'].includes(kind)) {
            assert.equal(exception.error.eventName, 'probe');
            if (kind === 'circular') assert.equal(exception.error.data, circular);
            if (kind === 'transport') assert.equal(exception.error.error.message, 'send failure');
        } else {
            assert.equal(exception.error, undefined);
        }
        const healthy = new Promise<void>(resolve => client.on('healthy', () => resolve()));
        peer.emit('healthy', true);
        await within(healthy, 'message after exception');
        assert.deepStrictEqual(watched.entries.map(entry => entry.event), ['connect', 'exception']);
        assert(client.connected);
        watched.consistent();
    });
}

test('onEvent invokes every listener before allEventFunc', async context => {
    const { url } = await createLiteServer(context, 0, {}, createLogger());
    const { client } = watchClient(context);
    const calls: string[] = [];
    assert.equal(client.onEvent('connect', () => { calls.push('old'); }), client);
    client.onEvent('connect', () => { assert(client.connected); calls.push('new'); });
    client.allEventFunc = event => { calls.push(`all:${event}`); };
    await within(client.connectPromise(url), 'connection');
    assert.deepStrictEqual(calls, ['old', 'new', 'all:connect']);
});

test('destroy cancels pending retries and removes event callbacks', async context => {
    const { url } = await unusedAddress(context);
    const watched = watchClient(context, {
        autoReconnect: true,
        backoff: { baseMs: 50, maxMs: 50, jitter: 0, maxRetries: 2 },
    });
    await within(watched.client.connectPromise(url), 'initial failure');
    await watched.wait('reconnect');
    watched.client.destroy();
    const count = watched.entries.length;
    await delay(100);
    assert.equal(watched.entries.length, count);
    assert.equal(watched.events('reconnect_fail').length, 0);
    assert.equal(watched.events('retries_exhausted').length, 0);
    assert.equal(watched.client.allEventFunc, undefined);
    assert.equal(watched.client.timeoutHandle, null);
    watched.consistent();
});

test('all socketClientEvent types were triggered through their real entry points', () => {
    assert.deepStrictEqual([...observed].sort(), Object.keys(eventTypes).sort());
});
