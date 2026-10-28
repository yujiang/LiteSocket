const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { once } = require('node:events');
const { runInNewContext } = require('node:vm');
const { execFileSync } = require('node:child_process');
const full = require('../..');

const root = resolve(__dirname, '../..');
const source = readFileSync(resolve(root, 'lib/client/litesocket.global.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

async function within(promise, description) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 3000);
        })]);
    } finally { clearTimeout(timer); }
}

async function waitUntil(predicate, description) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        assert(Date.now() < deadline, `Timed out: ${description}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function browser(context) {
    let nextId = 1;
    const timers = new Map();
    const sandbox = {
        WebSocket: globalThis.WebSocket, console, performance,
        TextDecoder, ArrayBuffer, Uint8Array, AbortController, DOMException,
        setTimeout(fn, ms, ...args) {
            const id = nextId++;
            timers.set(id, setTimeout(() => { timers.delete(id); fn(...args); }, ms));
            return id;
        },
        setInterval(fn, ms, ...args) {
            const id = nextId++;
            timers.set(id, setInterval(fn, ms, ...args));
            return id;
        },
        clearTimeout(id) { clearTimeout(timers.get(id)); timers.delete(id); },
        clearInterval(id) { clearInterval(timers.get(id)); timers.delete(id); },
    };
    assert.equal(typeof sandbox.WebSocket, 'function', 'Bundle tests require Node.js 22+ native WebSocket');
    runInNewContext(source, sandbox, { filename: 'litesocket.global.js' });
    context.after(() => {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
    });
    assert.equal(sandbox.process, undefined);
    assert.equal(sandbox.Buffer, undefined);
    assert.equal(sandbox.require, undefined);
    return { api: sandbox.LiteSocket, timers };
}

async function close(server) {
    if (!server.wss) return;
    const closed = once(server.wss, 'close');
    server.close();
    await within(closed, 'server close');
}

async function listen(context, Server = full.LiteServer) {
    const logger = full.createSliceLogger();
    const server = new Server('bundle-test', logger);
    context.after(() => close(server.io || server));
    const result = server instanceof full.IOServer
        ? await server.listen(0) : await server.listenPromise(0);
    assert.deepEqual(result, [true]);
    const transport = server.io || server;
    return { server, url: `ws://127.0.0.1:${transport.port}`, logger };
}

test('full package entry exports server and client APIs', () => {
    for (const name of ['LiteServer', 'LiteServerClient', 'IOServer', 'IOServerSocket', 'LiteRoom', 'LiteClient', 'IOClient']) {
        assert.equal(typeof full[name], 'function', name);
    }
});

test('browser ESM and script builds expose client APIs without server code or Node globals', async context => {
    const { api } = browser(context);
    const esm = await import('../../lib/client/index.js');
    for (const name of ['LiteClient', 'IOClient', 'ErrorEnum', 'setMsgNameFunc', 'createHeadLogger']) {
        assert(api[name], name);
        assert(esm[name], name);
    }
    for (const name of ['LiteServer', 'IOServer', 'LiteRoom', 'IOServerSocket', 'SockWrap']) {
        assert.equal(api[name], undefined, name);
        assert.equal(esm[name], undefined, name);
    }
    assert.doesNotMatch(source, /\brequire\s*\(|node:|node_modules\/|class LiteServer\b/);
});

test('browser-only declarations compile without @types/node or ws', () => {
    try {
        execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'test/build/tsconfig.browser-types.json'], {
            cwd: root, stdio: 'pipe', encoding: 'utf8',
        });
    } catch (error) {
        const diagnostics = [error.stdout, error.stderr].filter(Boolean).join('\n');
        assert.fail(`Browser declaration type check failed:\n${diagnostics || error.message}`);
    }
});

for (const platform of ['Node.js', 'browser']) {
    test(`${platform} build exposes sendMsg and exchanges mod messages in both directions`, async context => {
        const { server, url, logger } = await listen(context);
        const api = platform === 'browser' ? browser(context).api : full;
        const client = new api.LiteClient('send-msg', logger);
        context.after(() => client.destroy());
        assert.equal(client.sendMsg(950003, 'not connected'), false);
        assert.equal((await within(client.connectPromise(url), 'sendMsg connection'))[0], true);
        const received = new Promise(resolve => server.onMessage('mod', (peer, data) => resolve({ peer, data })));
        assert.equal(client.sendMsg(950003, 'payload'), true);
        const incoming = await within(received, 'sendMsg received by server');
        assert.deepEqual(incoming.data, [950003, 'payload']);
        assert.equal(incoming.peer, server.findById(client.getServerId()));
        const reply = new Promise(resolve => client.on('mod', resolve));
        assert.equal(incoming.peer.sendMsg(950004, 'reply'), true);
        assert.deepEqual(plain(await within(reply, 'sendMsg reply')), [950004, 'reply']);
        const closed = new Promise(resolve => client.onEvent('close', resolve));
        client.close();
        await within(closed, 'sendMsg client close');
        assert.equal(client.sendMsg(950003, 'closed'), false);
    });
}

test('browser client connects and receives text and binary JSON without Buffer', async context => {
    const { server, url, logger } = await listen(context);
    const { api, timers } = browser(context);
    const client = new api.LiteClient('browser', logger);
    context.after(() => client.destroy());
    assert.deepEqual(plain(await within(client.connectPromise(url), 'browser connect')), [true, '']);
    const messages = [];
    client.on('reply', data => { messages.push(data); });
    server.onMessage('hello', (peer, data) => peer.emit('reply', data));
    client.emit('hello', { text: '浏览器 hello' });
    await waitUntil(() => messages.length === 1, 'text reply');
    server.findById(client.getServerId()).ws.send(Buffer.from(JSON.stringify({ eventName: 'reply', data: 'binary JSON' })));
    await waitUntil(() => messages.length === 2, 'binary reply');
    assert.deepEqual(plain(messages), [{ text: '浏览器 hello' }, 'binary JSON']);
    client.destroy();
    assert.equal(timers.size, 0);
});

test('browser IOClient supports RPC and timeout polling with numeric timer IDs', async context => {
    const { server, url, logger } = await listen(context, full.IOServer);
    const { api, timers } = browser(context);
    const client = new api.IOClient('browser-rpc', logger, { checktimeout: true, checkIntervalMs: 5 });
    context.after(() => client.destroy('cleanup'));
    let finish;
    const pendingReply = new Promise(resolve => { finish = resolve; });
    context.after(() => finish([full.ErrorEnum.ErrorOk]));
    server.onCallback(950001, (_peer, a, b) => [full.ErrorEnum.ErrorOk, a + b]);
    server.onCallback(950002, () => pendingReply);
    const messages = [];
    server.onMessage(950003, (_peer, text, count) => { messages.push([text, count]); });
    assert(await within(client.connectServer(url, () => {}), 'browser RPC connection'));
    client.sendMsg(950003, 'browser sendMsg', 7);
    await waitUntil(() => messages.length === 1, 'browser sendMsg');
    assert.deepEqual(messages, [['browser sendMsg', 7]]);
    assert.deepEqual(plain(await within(client.asend([950001, 3, 5], 1000), 'browser RPC')), [api.ErrorEnum.ErrorOk, 8]);
    assert.deepEqual(plain(await within(client.asend([950002], 20), 'browser timeout')), [api.ErrorEnum.Callback_timeout]);
    client.destroy('test finished');
    assert.equal(timers.size, 0);
});

test('browser client automatically reconnects using cancellable browser timers', async context => {
    const { server, url, logger } = await listen(context);
    const { api, timers } = browser(context);
    const client = new api.LiteClient('browser-reconnect', logger, {
        autoReconnect: true, backoff: { baseMs: 10, maxMs: 10, jitter: 0, maxRetries: 2 },
    });
    context.after(() => client.destroy());
    const connects = [];
    client.onEvent('connect', times => { connects.push(times); });
    await within(client.connectPromise(url), 'initial browser connection');
    server.findById(client.getServerId()).terminate();
    await waitUntil(() => connects.length === 2, 'browser reconnection');
    assert.deepEqual(connects, [1, 2]);
    assert(client.connected);
    client.destroy();
    assert.equal(timers.size, 0);
});

test('browser destroy aborts a pending reconnect delay', async context => {
    const { server, url, logger } = await listen(context);
    await close(server);
    const { api, timers } = browser(context);
    const client = new api.LiteClient('browser-cancel', logger, {
        autoReconnect: true, backoff: { baseMs: 60, maxMs: 60, jitter: 0, maxRetries: 2 },
    });
    context.after(() => client.destroy());
    let retries = 0;
    client.onEvent('reconnect', () => { retries++; });
    assert.equal((await within(client.connectPromise(url), 'failed connection'))[0], false);
    await waitUntil(() => retries === 1, 'first retry scheduled');
    client.destroy();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(retries, 1);
    assert.equal(timers.size, 0);
});
