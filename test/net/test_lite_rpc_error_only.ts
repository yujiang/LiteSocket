import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ErrorEnum } from '../../src/net/ErrorEnum';
import { NetEventEnum } from '../../src/net/msgid';
import { SessionCallback } from '../../src/net/SessionCallback';
import { createIOPair, deferred } from '../io_test_helpers';
import { waitUntil, within } from '../lite_test_helpers';

const messageId = 930001;

for (const direction of ['client', 'server'] as const) {
    test(`error-only RPC: ${direction} preserves custom codes and forwards arguments`, async context => {
        const { server, client, connect, peer } = await createIOPair(context);
        const received: unknown[][] = [];
        const customCode = ErrorEnum.Max + 27;
        if (direction === 'client') {
            server.onCallback(messageId, (_socket, ...args) => {
                received.push(args.slice(0, -1));
                return [customCode, 'ignored result'];
            });
        } else {
            client.onCallback(messageId, (...args) => {
                received.push(args.slice(0, -1));
                return [customCode, 'ignored result'];
            });
        }
        assert.equal(await client.asendCallbacke(messageId), ErrorEnum.Net_notconnect);
        await connect();
        const socket = peer();
        const send = direction === 'client'
            ? () => client.asendCallbacke(messageId, 'payload', 42)
            : () => socket.asendCallbacke(messageId, 'payload', 42);
        assert.equal(await within(send(), 'custom code'), customCode);
        assert.deepStrictEqual(received, [['payload', 42]]);
        const handler = () => ErrorEnum.ErrorOk;
        if (direction === 'client') server.onCallback(messageId, handler);
        else client.onCallback(messageId, handler);
        assert.equal(await send(), ErrorEnum.ErrorOk);
        assert.deepStrictEqual(client.callback.callbacks, {});
        assert.deepStrictEqual(socket.session.callbacks, {});
    });

    for (const timeout of [0, 25]) {
        test(`error-only RPC: ${direction} timeout=${timeout} expires once and ignores late replies`, async context => {
            const { server, client, connect, peer } = await createIOPair(context, { checktimeout: false });
            // Integer timestamps make the exact boundary independent of floating-point rounding.
            context.mock.method(SessionCallback, 'getTime', () => 1000);
            const reply = deferred<number>();
            context.after(() => reply.resolve(ErrorEnum.ErrorOk));
            let calls = 0;
            const handler = () => { calls++; return reply.promise; };
            if (direction === 'client') server.onCallback(messageId, handler);
            else client.onCallback(messageId, handler);
            await connect();
            const socket = peer();
            const registry = direction === 'client' ? client.callback : socket.session;
            registry.timeoutMax = 40;
            const pending = direction === 'client'
                ? client.sendCallbackeTimetout(timeout, messageId)
                : socket.asendCallbackeTimeout(timeout, messageId);
            await waitUntil(() => calls === 1, 'request dispatched');
            const entry = Object.values(registry.callbacks)[0];
            assert.equal(entry[4], timeout, 'explicit timeout reaches the pending registry');
            const effectiveTimeout = timeout || registry.timeoutMax;
            assert.equal(registry.checkTimeout(entry[3] + effectiveTimeout), 0);
            assert.equal(registry.checkTimeout(entry[3] + effectiveTimeout + 1), 1);
            assert.equal(await within(pending, 'timeout result'), ErrorEnum.Callback_timeout);
            assert.equal(registry.checkTimeout(entry[3] + 100), 0);
            reply.resolve(ErrorEnum.ErrorOk);
            // A subsequent RPC response is ordered after the late response on the same socket.
            if (direction === 'client') server.onCallback(messageId + 1, () => ErrorEnum.ErrorOk);
            else client.onCallback(messageId + 1, () => ErrorEnum.ErrorOk);
            const next = direction === 'client' ? client.asendCallbacke(messageId + 1) : socket.asendCallbacke(messageId + 1);
            assert.equal(await within(next, 'RPC after late reply'), ErrorEnum.ErrorOk);
            assert.deepStrictEqual(registry.callbacks, {});
        });
    }

    test(`error-only RPC: ${direction} disconnect settles pending requests`, async context => {
        const { server, client, connect, peer } = await createIOPair(context);
        const reply = deferred<number>();
        context.after(() => reply.resolve(ErrorEnum.ErrorOk));
        let calls = 0;
        const handler = () => { calls++; return reply.promise; };
        if (direction === 'client') server.onCallback(messageId, handler);
        else client.onCallback(messageId, handler);
        await connect();
        const socket = peer();
        const registry = direction === 'client' ? client.callback : socket.session;
        const pending = direction === 'client' ? client.asendCallbacke(messageId) : socket.asendCallbacke(messageId);
        await waitUntil(() => calls === 1, 'pending request');
        socket.terminate();
        assert.equal(await within(pending, 'disconnect result'), ErrorEnum.Callback_disconnect);
        assert.deepStrictEqual(registry.callbacks, {});
    });
}

test('server error-only APIs return NoSession without sending', async context => {
    const { connect, peer } = await createIOPair(context);
    await connect();
    const socket = peer();
    const session = socket.session;
    socket.session = undefined;
    try {
        assert.equal(await socket.asendMode(NetEventEnum.eventCallback, [messageId]), ErrorEnum.NoSession);
        assert.equal(await socket.asendCallbacke(messageId), ErrorEnum.NoSession);
        assert.equal(await socket.asendCallbackeTimeout(25, messageId), ErrorEnum.NoSession);
        assert.deepStrictEqual(session.callbacks, {});
    } finally {
        socket.session = session;
    }
});
