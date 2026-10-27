import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { get as httpsGet, Server as HttpsServer } from 'node:https';
import { connect as tcpConnect } from 'node:net';
import { resolve } from 'node:path';
import { test, TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { LiteServer } from '../../src/net/LiteServer';
import { LiteOptionsInput, SocketCloseCode, getWsUrl } from '../../src/net/LiteNet';
import { IOServer } from '../../src/net/IOServer';
import { IOClient } from '../../src/net/IOClient';
import { ErrorEnum } from '../../src/net/ErrorEnum';
import { createClient, createLiteServer, connect, within } from '../lite_test_helpers';
import { createLogger } from '../logger_helpers';

// 从编译后的 .test-build/test/net 定位源码中的证书，无需复制 PEM 或安装 OpenSSL。
const fixture = resolve(__dirname, '../../../test/fixtures/tls');
const keyfile = resolve(fixture, 'localhost-key.pem');
const certfile = resolve(fixture, 'localhost-cert.pem');
const ca = readFileSync(certfile);
const tlsOptions = { keyfile, certfile };
const trustedSocket = (url: string) => new WebSocket(url, { ca });

function serverForFailure(context: TestContext, opts: LiteOptionsInput) {
    const server = new LiteServer('wss-failure', createLogger(), opts);
    context.after(() => server.close());
    return server;
}

test('getWsUrl defaults to WS and can explicitly select WSS', () => {
    assert.equal(getWsUrl('localhost', 8080), 'ws://localhost:8080');
    assert.equal(getWsUrl('localhost', 8443, true), 'wss://localhost:8443');
});

test('without certificate configuration the server still accepts plain WS', async context => {
    const { url } = await createLiteServer(context, 0, {}, createLogger());
    assert(url.startsWith('ws://'));
    await connect(createClient(context), url);
});

test('WSS performs a verified TLS handshake and exchanges messages in both directions', async context => {
    const { server, url } = await createLiteServer(context, 0, { ...tlsOptions, maxRecvLen: 512, maxSendLen: 1024 }, createLogger());
    assert(url.startsWith('wss://'));
    const client = createClient(context, { createSocket: trustedSocket });
    await connect(client, url);
    assert.equal(client.getMaxSendLen(), 512);
    assert.equal(client.getMaxRecvLen(), 1024);
    server.onMessage('echo', (peer, data) => peer.emit('reply', { received: data }));
    const reply = new Promise<unknown>(resolve => client.on('reply', resolve));
    client.emit('echo', { text: 'TLS hello', value: 7 });
    assert.deepStrictEqual(await within(reply, 'WSS reply'), { received: { text: 'TLS hello', value: 7 } });
    assert.equal(client.events.count('connect'), 1);
    assert.equal(client.events.count('error'), 0);
});

test('IOServer forwards TLS options and supports RPC over WSS', async context => {
    const logger = createLogger();
    const server = new IOServer('wss-rpc-server', logger);
    const client = new IOClient('wss-rpc-client', logger, { checktimeout: true, checkIntervalMs: 5 }, { createSocket: trustedSocket });
    context.after(() => { client.destroy('cleanup'); server.close(); });
    server.onCallback(940001, (_peer, left: number, right: number) => [ErrorEnum.ErrorOk, left + right]);
    assert.deepStrictEqual(await within(server.listen('wss-rpc', 0, tlsOptions), 'WSS RPC listen'), [true]);
    assert(await within(client.connectServer(getWsUrl('127.0.0.1', server.io.port, true), () => {}), 'WSS RPC connection'));
    assert.deepStrictEqual(await within(client.asend([940001, 3, 5], 1000), 'WSS RPC result'), [ErrorEnum.ErrorOk, 8]);
});

test('an untrusted self-signed certificate fails validation without accepting a client', async context => {
    const { server, url } = await createLiteServer(context, 0, tlsOptions, createLogger());
    const client = createClient(context);
    assert.deepStrictEqual(await within(client.connectPromise(url), 'certificate rejection'), [false, 'error']);
    await client.events.waitForCount('close', 1);
    assert.match(String(client.events.entries.find(entry => entry.event === 'error').err.message), /self.signed|certificate/i);
    assert.equal(client.events.count('connect_fail'), 1);
    assert.equal(server.clientsNum(), 0);
});

test('trusting the certificate does not bypass hostname validation', async context => {
    const { url } = await createLiteServer(context, 0, tlsOptions, createLogger());
    const client = createClient(context, {
        createSocket: url => {
            const options = { ca, servername: 'wrong-host.invalid' };
            return new WebSocket(url, options);
        },
    });
    assert.deepStrictEqual(await within(client.connectPromise(url), 'hostname rejection'), [false, 'error']);
    await client.events.waitForCount('close', 1);
    assert.match(String(client.events.entries.find(entry => entry.event === 'error').err.message), /hostname|altname|altnames/i);
    assert.equal(client.events.count('connect'), 0);
});

test('a WSS listener rejects a plain WS connection', async context => {
    const { port } = await createLiteServer(context, 0, tlsOptions, createLogger());
    const client = createClient(context);
    assert.deepStrictEqual(await within(client.connectPromise(getWsUrl('127.0.0.1', port)), 'plain connection rejected'), [false, 'error']);
    await client.events.waitForCount('close', 1);
    assert.equal(client.events.count('connect'), 0);
});

const invalidOptions: Array<{ name: string, opts: LiteOptionsInput, code?: string }> = [
    { name: 'only keyfile', opts: { keyfile }, code: 'ERR_TLS_CONFIG' },
    { name: 'only certfile', opts: { certfile }, code: 'ERR_TLS_CONFIG' },
    { name: 'empty keyfile', opts: { keyfile: '', certfile }, code: 'ERR_TLS_CONFIG' },
    { name: 'empty certfile', opts: { keyfile, certfile: '' }, code: 'ERR_TLS_CONFIG' },
    { name: 'missing key file', opts: { keyfile: resolve(fixture, 'missing-key.pem'), certfile }, code: 'ENOENT' },
    { name: 'missing certificate file', opts: { keyfile, certfile: resolve(fixture, 'missing-cert.pem') }, code: 'ENOENT' },
    { name: 'invalid PEM certificate', opts: { keyfile, certfile: resolve(fixture, 'README.md') } },
    { name: 'invalid PEM key', opts: { keyfile: resolve(fixture, 'README.md'), certfile } },
];
for (const { name, opts, code } of invalidOptions) {
    test(`TLS configuration failure: ${name}`, async context => {
        const intervals = context.mock.method(globalThis, 'setInterval');
        const server = serverForFailure(context, opts);
        const [ok, error] = await within(server.listenPromise(0), name);
        assert.equal(ok, false);
        assert(error instanceof Error);
        if (code) assert.equal(error.code, code);
        assert.equal(server.wss, null);
        assert.equal(intervals.mock.callCount(), 0);
        assert.doesNotThrow(() => server.close());
    });
}

test('WSS port conflict returns EADDRINUSE and preserves the existing listener', async context => {
    const occupied = await createLiteServer(context, 0, tlsOptions, createLogger());
    const intervals = context.mock.method(globalThis, 'setInterval');
    const failed = serverForFailure(context, tlsOptions);
    const [ok, error] = await within(failed.listenPromise(occupied.port), 'TLS port conflict');
    assert.equal(ok, false);
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(failed.wss, null);
    assert.equal(intervals.mock.callCount(), 0);
    await connect(createClient(context, { createSocket: trustedSocket }), occupied.url);
});

test('invalid WSS port returns ERR_SOCKET_BAD_PORT without leaking a listener', async context => {
    const server = serverForFailure(context, tlsOptions);
    const [ok, error] = await within(server.listenPromise(-1), 'invalid TLS port');
    assert.equal(ok, false);
    assert.equal(error.code, 'ERR_SOCKET_BAD_PORT');
    assert.equal(server.wss, null);
    assert.doesNotThrow(() => server.close());
});

test('WSS closes the HTTPS listener, connected clients and rooms and releases its port', async context => {
    const { server, url, port } = await createLiteServer(context, 0, tlsOptions, createLogger());
    const client = createClient(context, { createSocket: trustedSocket });
    await connect(client, url);
    server.findById(client.getServerId()).join('main');
    const wss = server.wss;
    const transport = wss.options.server;
    assert(transport instanceof HttpsServer);
    const closed = Promise.all([once(wss, 'close'), once(transport, 'close')]);
    server.close();
    await within(closed, 'WSS resources closed');
    await client.events.waitForCount('close', 1);
    assert.equal(transport.listening, false);
    assert.equal(client.events.entries.find(entry => entry.event === 'close').err.code, SocketCloseCode.normal);
    assert.equal(client.connected, false);
    assert.equal(server.clientsNum(), 0);
    assert.equal(server.getRoom('main'), undefined);
    assert.doesNotThrow(() => server.close());
    // 重新绑定同一端口，确认不只是关闭了 WebSocketServer。
    const replacement = await createLiteServer(context, port, {}, createLogger());
    await connect(createClient(context), replacement.url);
});

test('closing WSS also closes TCP connections that never complete TLS negotiation', async context => {
    const { server, port } = await createLiteServer(context, 0, tlsOptions, createLogger());
    const socket = tcpConnect(port, '127.0.0.1');
    context.after(() => socket.destroy());
    await within(once(socket, 'connect'), 'raw TCP connection');
    const transport = server.wss.options.server;
    const closed = Promise.all([once(socket, 'close'), once(transport, 'close')]);
    server.close();
    await within(closed, 'unfinished TLS connection closed');
    assert(socket.destroyed);
});

test('ordinary HTTPS requests receive 426 instead of hanging', async context => {
    const { url, port } = await createLiteServer(context, 0, tlsOptions, createLogger());
    const response = await within(new Promise<{ code: number, body: string }>((resolve, reject) => {
        const request = httpsGet({ host: '127.0.0.1', port, ca, agent: false }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ code: res.statusCode, body }));
            res.on('error', reject);
        });
        request.on('error', reject);
        context.after(() => request.destroy());
    }), 'HTTPS upgrade response');
    assert.deepStrictEqual(response, { code: 426, body: 'WebSocket upgrade required' });
    await connect(createClient(context, { createSocket: trustedSocket }), url);
});
