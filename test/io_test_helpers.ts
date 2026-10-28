import { strict as assert } from 'node:assert';
import type { TestContext } from 'node:test';
import { createLogger, Logger } from './logger_helpers';
import { IOClient } from '../src/net/IOClient';
import { IOServer } from '../src/net/IOServer';
import type { ClientParam } from '../src/net/NetCallback';
import { getWsUrl, LiteOptionsInput } from '../src/net/LiteNet';
import { within } from './lite_test_helpers';

export function createIOClient(context: TestContext, logger: Logger, param: ClientParam = {}) {
    const client = new IOClient('rpc-test-client', logger, { checktimeout: true, checkIntervalMs: 5, ...param }, {});
    context.after(() => client.destroy('test cleanup'));
    return client;
}

export async function createIOPair(context: TestContext, param: ClientParam = {}, opts: LiteOptionsInput = {}) {
    const logger = createLogger({ silent: true });
    const errors: unknown[][] = [];
    context.mock.method(logger, 'error', (...args: unknown[]) => {
        errors.push(args);
        return logger;
    });
    const server = new IOServer('rpc-test-server', logger);
    const client = createIOClient(context, logger, param);
    context.after(() => {
        client.destroy('test cleanup');
        server.close();
        logger.close();
    });
    assert.deepStrictEqual(await within(server.listen(0, opts), 'RPC server listen'), [true]);
    const url = getWsUrl('127.0.0.1', server.io.port, !!opts.keyfile && !!opts.certfile);
    const connect = async () => {
        assert(await within(client.connectServer(url, () => {}), 'RPC client connect'));
    };
    const peer = () => {
        const socket = server.findById(client.socket.getServerId());
        assert(socket);
        return socket;
    };
    const barrier = async () => {
        const received = new Promise<void>(resolve => client.socket.on('rpc-test-barrier', () => resolve()));
        peer().emit('rpc-test-barrier', true);
        await within(received, 'RPC response barrier');
    };
    return { server, client, logger, errors, url, connect, peer, barrier };
}

export function deferred<Result>() {
    let resolve: (result: Result) => void;
    const promise = new Promise<Result>(resolver => { resolve = resolver; });
    return { promise, resolve };
}
