// 通过真实连接、心跳和协议错误触发 LiteServer 的所有 clientEvent。
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test, TestContext } from 'node:test';
import { LiteClient } from '../../src/net/LiteClient';
import { LiteServer, clientEvent } from '../../src/net/LiteServer';
import type { LiteServerClient } from '../../src/net/LiteServerClient';
import {
    BroadcastExceptionDetails, LiteOptionsInput, SocketCloseCode, msgInvalidPacket,
    msgJsonParseError, msgJsonStringError, msgRecvMax, msgSendError, msgSendMax,
} from '../../src/net/LiteNet';
import { terminateClient, waitUntil, within } from '../lite_test_helpers';
import { createLogger } from '../logger_helpers';

const eventTypes: Record<clientEvent, true> = {
    'client-connect': true, 'client-disconnect': true, 'client-close': true,
    'client-error': true, exception: true, 'pong-timeout': true,
};
const observed = new Set<clientEvent>();
type Entry = {
    event: clientEvent, client: LiteServerClient, reason?: string | number, error?: any,
    connected: boolean, registered: boolean, inRoom: boolean,
};

async function watchServer(context: TestContext, opts: LiteOptionsInput = {}) {
    const server = new LiteServer('server-events-test', createLogger(), opts);
    const entries: Entry[] = [];
    for (const event of Object.keys(eventTypes) as clientEvent[]) {
        server.onClient(event, (client, reason, error) => {
            observed.add(event);
            entries.push({
                event, client, reason, error, connected: client.connected,
                registered: server.findById(client.id) === client,
                inRoom: server.getRoom('main')?.has(client) ?? false,
            });
        });
    }
    context.after(async () => {
        const wss = server.wss;
        if (!wss) return;
        const closed = once(wss, 'close');
        for (const client of server.clients.values()) client.terminate();
        server.close();
        await within(closed, 'server cleanup');
    });
    assert.deepStrictEqual(await within(server.listenPromise(0), 'server listen'), [true]);
    const events = (event: clientEvent, client?: LiteServerClient) =>
        entries.filter(entry => entry.event === event && (!client || entry.client === client));
    const wait = (event: clientEvent, client?: LiteServerClient) =>
        waitUntil(() => events(event, client).length > 0, event);
    const connect = async () => {
        const client = new LiteClient('events-client', createLogger());
        context.after(async () => { client.destroy(); await terminateClient(client); });
        assert.deepStrictEqual(await within(client.connectPromise(`ws://127.0.0.1:${server.port}`), 'connection'), [true, '']);
        const peer = server.findById(client.getServerId());
        assert(peer);
        return { client, peer };
    };
    return { server, entries, events, wait, connect };
}

const closingCases = [
    { action: 'client-close', code: SocketCloseCode.test, reason: 'client goodbye' },
    { action: 'server-close', code: SocketCloseCode.test, reason: 'server goodbye' },
    { action: 'kickoff', code: SocketCloseCode.disconnect, reason: 'admin kick' },
    { action: 'terminate', code: 1006, reason: '' },
];
for (const { action, code, reason } of closingCases) {
    test(`client-connect, client-disconnect, client-close: ${action}`, async context => {
        const watched = await watchServer(context);
        const { server, entries, events } = watched;
        const { client, peer } = await watched.connect();
        const connected = events('client-connect')[0];
        assert.equal(connected.client, peer);
        assert.equal(connected.reason, undefined);
        assert.equal(connected.error, undefined);
        assert(connected.connected && connected.registered);
        assert.equal(peer.server, server);
        assert(peer.remoteAddress.includes('127.0.0.1'));
        peer.join('main');
        switch (action) {
            case 'client-close': client.disconnect(SocketCloseCode.test, reason); break;
            case 'server-close': peer.close(SocketCloseCode.test, reason); break;
            case 'kickoff': assert(server.kickoff(peer.id, reason)); break;
            case 'terminate': peer.terminate(); break;
        }
        await watched.wait('client-close', peer);
        assert.deepStrictEqual(entries.map(entry => entry.event), ['client-connect', 'client-disconnect', 'client-close']);
        assert(entries.every(entry => entry.client === peer));
        const disconnected = events('client-disconnect')[0];
        assert.equal(disconnected.reason, 'close');
        assert.deepStrictEqual(disconnected.error, { code, reason });
        assert.equal(disconnected.connected, false);
        const closed = events('client-close')[0];
        assert.equal(closed.reason, reason);
        assert.deepStrictEqual(closed.error, { code, reason });
        assert.equal(closed.registered, false);
        assert.equal(closed.inRoom, false);
        assert.equal(server.clientsNum(), 0);
        assert.equal(server.getRoom('main'), undefined);
    });
}

test('client-error: disconnect precedes error diagnostics and later close does not duplicate it', async context => {
    const watched = await watchServer(context);
    const { peer } = await watched.connect();
    peer.join('main');
    const failure = new Error('server transport failure');
    // 通过真实 ws 的公开 error 入口注入，避免依赖不稳定的操作系统网络错误。
    peer.ws.emit('error', failure);
    assert.deepStrictEqual(watched.entries.map(entry => entry.event), ['client-connect', 'client-disconnect', 'client-error']);
    const disconnected = watched.events('client-disconnect')[0];
    assert.equal(disconnected.reason, 'error');
    assert.equal(disconnected.error, failure);
    assert.equal(disconnected.connected, false);
    const error = watched.events('client-error')[0];
    assert.equal(error.client, peer);
    assert.equal(error.reason, failure.message);
    assert.equal(error.error, failure);
    peer.terminate();
    await watched.wait('client-close', peer);
    assert.equal(watched.events('client-disconnect').length, 1);
    assert.deepStrictEqual(watched.entries.map(entry => entry.event),
        ['client-connect', 'client-disconnect', 'client-error', 'client-close']);
    assert.equal(watched.server.getRoom('main'), undefined);
    assert.equal(watched.server.findById(peer.id), undefined);
});

test('pong-timeout: disconnect precedes heartbeat diagnostics and close', async context => {
    const watched = await watchServer(context, { heartbeatInterval: 5, heartbeatTimeout: 60 });
    const { client, peer } = await watched.connect();
    peer.join('main');
    client.stopPong(true);
    await watched.wait('client-close', peer);
    assert.deepStrictEqual(watched.entries.map(entry => entry.event),
        ['client-connect', 'client-disconnect', 'pong-timeout', 'client-close']);
    assert.equal(watched.events('client-disconnect')[0].reason, 'pong-timeout');
    assert.equal(watched.events('client-disconnect')[0].connected, false);
    const timeout = watched.events('pong-timeout')[0];
    assert.equal(timeout.client, peer);
    assert.equal(timeout.reason, undefined);
    assert.equal(timeout.error, undefined);
    assert.equal(watched.server.findById(peer.id), undefined);
    assert.equal(watched.server.getRoom('main'), undefined);
});

const exceptionCases = [
    { kind: 'invalid-json', reason: msgJsonParseError },
    { kind: 'invalid-packet', reason: msgInvalidPacket },
    { kind: 'oversized-receive', reason: msgRecvMax },
    { kind: 'oversized-send', reason: msgSendMax },
    { kind: 'circular', reason: msgJsonStringError },
    { kind: 'transport', reason: msgSendError },
];
for (const { kind, reason } of exceptionCases) {
    test(`exception: ${kind} identifies the client and preserves message delivery`, async context => {
        const watched = await watchServer(context, { maxRecvLen: 256, maxSendLen: 256 });
        const { client, peer } = await watched.connect();
        const circular: { self?: unknown } = {};
        circular.self = circular;
        switch (kind) {
            case 'invalid-json': client.wsSend('{invalid'); break;
            case 'invalid-packet': client.wsSend(JSON.stringify({ eventName: '' })); break;
            case 'oversized-receive': client.wsSend('x'.repeat(512)); break;
            case 'oversized-send': peer.emit('probe', 'x'.repeat(512)); break;
            case 'circular': peer.emit('probe', circular); break;
            case 'transport': {
                const send = context.mock.method(peer.ws, 'send', () => { throw new Error('send failure'); });
                peer.emit('probe', 'payload');
                send.mock.restore();
                break;
            }
        }
        await watched.wait('exception', peer);
        const exception = watched.events('exception')[0];
        assert.equal(exception.client, peer);
        assert.equal(exception.reason, reason);
        assert(exception.connected && exception.registered);
        if (['oversized-send', 'circular', 'transport'].includes(kind)) {
            assert.equal(exception.error.eventName, 'probe');
            if (kind === 'circular') assert.equal(exception.error.data, circular);
            if (kind === 'transport') assert.equal(exception.error.error.message, 'send failure');
        } else {
            assert.equal(exception.error, undefined);
        }
        let received = false;
        watched.server.onMessage('healthy', (sender, data) => {
            assert.equal(sender, peer);
            assert.equal(data, 'after exception');
            received = true;
        });
        client.emit('healthy', 'after exception');
        await waitUntil(() => received, 'message after exception');
        const reply = new Promise<void>(resolve => client.on('reply', () => resolve()));
        peer.emit('reply', true);
        await within(reply, 'reply after exception');
        assert.deepStrictEqual(watched.entries.map(entry => entry.event), ['client-connect', 'exception']);
    });
}

test('events and room cleanup are isolated between clients', async context => {
    const watched = await watchServer(context);
    const first = await watched.connect();
    const second = await watched.connect();
    assert.notEqual(first.peer.id, second.peer.id);
    first.peer.join('main');
    second.peer.join('main');
    assert(watched.server.kickoff(first.peer.id, 'first only'));
    await watched.wait('client-close', first.peer);
    assert.deepStrictEqual(watched.entries.filter(entry => entry.client === second.peer).map(entry => entry.event), ['client-connect']);
    assert.equal(watched.server.clientsNum(), 1);
    assert.equal(watched.server.findById(second.peer.id), second.peer);
    const room = watched.server.getRoom('main');
    assert.equal(room.size(), 1);
    assert(room.has(second.peer));
    assert(!room.has(first.peer));
    let received = false;
    watched.server.onMessage('healthy', sender => { assert.equal(sender, second.peer); received = true; });
    second.client.emit('healthy');
    await waitUntil(() => received, 'remaining client still usable');
});

test('onClient replaces the previous listener for the same event', async context => {
    const watched = await watchServer(context);
    const calls: string[] = [];
    watched.server.onClient('client-connect', () => { calls.push('old'); });
    watched.server.onClient('client-connect', peer => {
        assert(peer.connected);
        assert.equal(watched.server.findById(peer.id), peer);
        calls.push('new');
    });
    await watched.connect();
    assert.deepStrictEqual(calls, ['new']);
});

// 广播的异常属于 server.onEvent，不应归到任意单连接的 onClient('exception')。
for (const scope of ['server', 'room']) {
    for (const kind of ['oversized', 'circular']) {
        test(`broadcast exception: ${scope}/${kind} is reported once with broadcast details`, async context => {
            const watched = await watchServer(context, { maxSendLen: 256 });
            const first = await watched.connect();
            const second = await watched.connect();
            first.peer.join('main');
            second.peer.join('main');
            const errors: Array<{ reason: string, details: BroadcastExceptionDetails }> = [];
            watched.server.onEvent('exception', (reason, details) => { errors.push({ reason, details }); });
            const circular: { self?: unknown } = {};
            circular.self = circular;
            const payload = kind === 'oversized' ? 'x'.repeat(512) : circular;
            const received: unknown[] = [];
            first.client.on('probe', data => { received.push(data); });
            second.client.on('probe', data => { received.push(data); });
            if (scope === 'server') watched.server.broadcast('probe', payload);
            else watched.server.getRoom('main').broadcast('probe', payload);
            assert.equal(errors.length, 1);
            const { reason, details } = errors[0];
            assert.equal(reason, kind === 'oversized' ? msgSendMax : msgJsonStringError);
            assert.equal(details.eventName, 'probe');
            assert.equal(details.limit, 256);
            assert.equal(details.room, scope === 'room' ? 'main' : undefined);
            if (kind === 'oversized') assert(details.length >= details.limit);
            else assert(details.error instanceof Error);
            assert.equal(watched.events('exception').length, 0);
            watched.server.broadcast('probe', 'healthy');
            await waitUntil(() => received.length === 2, 'healthy broadcast');
            assert.deepStrictEqual(received, ['healthy', 'healthy']);
            assert(first.peer.connected && second.peer.connected);
        });
    }
}

test('all LiteServer clientEvent types were triggered through their real entry points', () => {
    assert.deepStrictEqual([...observed].sort(), Object.keys(eventTypes).sort());
});
