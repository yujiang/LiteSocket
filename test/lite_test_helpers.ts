import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createServer, Socket } from 'node:net';
import { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { LiteLogger } from '../src/public/log';
import { getWsUrl, LiteOptionsInput, socketClientEvent } from '../src/net/LiteNet';
import { clientEvent, LiteServer } from '../src/net/LiteServer';
import { LiteClient, LiteClientOptionsInput } from '../src/net/LiteClient';

const waitTimeout = 3000;

export async function within<T>(promise: Promise<T>, description: string, timeout = waitTimeout): Promise<T> {
    let timer: NodeJS.Timeout;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeout);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
    const deadline = performance.now() + waitTimeout;
    while (!predicate()) {
        assert(performance.now() < deadline, `Timed out: ${description}`);
        await delay(5);
    }
}

export class EventLog<Event extends string> {
    readonly entries: Array<{ event: Event, reason?: string | number, err?: any, clientId?: number }> = [];

    record(event: Event, reason?: string | number, err?: any, clientId?: number) {
        this.entries.push({ event, reason, err, clientId });
    }

    count(event: Event): number {
        return this.entries.filter(entry => entry.event === event).length;
    }

    waitForCount(event: Event, count: number): Promise<void> {
        return waitUntil(() => this.count(event) >= count, `${event} count >= ${count}`);
    }

    names(): Event[] {
        return this.entries.map(entry => entry.event);
    }
}

export class LiteServerTest extends LiteServer {
    readonly events = new EventLog<clientEvent>();

    constructor(opts: LiteOptionsInput = {}, logger: LiteLogger = console) {
        super('testS', logger, opts);
        const events: clientEvent[] = [
            'client-connect', 'client-disconnect', 'client-close',
            'client-error', 'exception', 'pong-timeout',
        ];
        for (const event of events) {
            this.onClient(event, (client, reason, err) => {
                this.events.record(event, reason, err, client.id);
            });
        }
    }
}

export class LiteClientTest extends LiteClient {
    readonly events = new EventLog<socketClientEvent>();

    constructor(opts: LiteClientOptionsInput = {}) {
        super('testC', console, opts);
    }

    override emitEvent(event: socketClientEvent, reason?: string | number, err?: any): void {
        this.events.record(event, reason, err);
        super.emitEvent(event, reason, err);
    }
}

export async function terminateClient(client: LiteClient): Promise<void> {
    const socket = client.ws;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    socket.terminate();
    await within(closed, 'client cleanup');
}

export function createClient(context: TestContext, opts: LiteClientOptionsInput = {}) {
    const client = new LiteClientTest(opts);
    context.after(() => terminateClient(client));
    return client;
}

export async function closeServer(server: LiteServerTest): Promise<void> {
    const websocketServer = server.wss;
    if (!websocketServer) return;
    const closed = new Promise<void>((resolve, reject) => {
        websocketServer.once('close', resolve);
        websocketServer.once('error', reject);
    });
    for (const client of server.clients.values()) client.terminate();
    server.close();
    await within(closed, 'server cleanup');
}

export async function createLiteServer(context: TestContext, port = 0, opts: LiteOptionsInput = {}, logger: LiteLogger = console) {
    const server = new LiteServerTest(opts, logger);
    context.after(() => closeServer(server));
    assert.deepStrictEqual(await within(server.listenPromise(port), 'server listening'), [true]);
    const address = server.wss.address();
    assert(address && typeof address === 'object');
    return { server, url: getWsUrl('127.0.0.1', address.port, !!opts.keyfile && !!opts.certfile), port: address.port };
}

export async function createStalledServer(context: TestContext) {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    context.after(async () => {
        for (const socket of sockets) socket.destroy();
        if (server.listening) {
            await within(new Promise<void>((resolve, reject) => {
                server.close(err => err ? reject(err) : resolve());
            }), 'raw server cleanup');
        }
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await within(listening, 'raw server listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    return { server, sockets, port: address.port, url: getWsUrl('127.0.0.1', address.port) };
}

export async function unusedAddress(context: TestContext) {
    const address = await createStalledServer(context);
    await new Promise<void>((resolve, reject) => {
        address.server.close(err => err ? reject(err) : resolve());
    });
    return address;
}

export async function connect(client: LiteClientTest, url: string) {
    assert.deepStrictEqual(await within(client.connectPromise(url), 'connectPromise'), [true, '']);
    assert(client.isConnected());
    assert(!client.isConnecting());
    assert.equal(client.timeoutHandle, null);
    assert(client.getServerId() > 0);
    assert(client.getSys());
}
