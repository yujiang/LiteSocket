import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ClientSession } from '../../src/net/ClientSession';
import { IOServer } from '../../src/net/IOServer';
import { SessionCallback } from '../../src/net/SessionCallback';
import { ErrorEnum } from '../../src/net/ErrorEnum';
import { NetEventEnum } from '../../src/net/msgid';
import { createSliceLogger } from '../../src/public/log';
import { createIOPair, deferred } from '../io_test_helpers';
import { within } from '../lite_test_helpers';

test('zero RPC timeout uses timeoutMax and an explicit timeout takes priority', async context => {
    const session = new ClientSession('timeouts', createSliceLogger());
    context.after(() => { session.reset(ErrorEnum.Callback_disconnect, false); session.close(); });
    session.resetSocket({ connected: true, emit() {} });
    session.timeoutMax = 100;
    context.mock.method(SessionCallback, 'getTime', () => 1000);
    const defaultRequest = session.asendMod('cb', [1]);
    const explicitRequest = session.asendMod('cb', [1], 10);
    assert.equal(session.checkTimeout(1010), 0);
    assert.equal(session.checkTimeout(1011), 1);
    assert.deepStrictEqual(await explicitRequest, [ErrorEnum.Callback_timeout]);
    assert.deepStrictEqual(Object.keys(session.callbacks), ['1']);
    assert.equal(session.checkTimeout(1100), 0);
    assert.equal(session.checkTimeout(1101), 1);
    assert.deepStrictEqual(await defaultRequest, [ErrorEnum.Callback_timeout]);
    assert.deepStrictEqual(session.callbacks, {});
});

test('IOClient.onCallback and IOServerSocket message helpers exchange business arguments', async context => {
    const { client, connect, peer } = await createIOPair(context);
    const received = deferred<string>();
    client.onMessage(910200, (text: string) => { received.resolve(text); });
    client.onCallback(910201, (value: number) => [ErrorEnum.ErrorOk, value * 2]);
    await connect();
    peer().sendMsg(910200, 'ordinary');
    assert.equal(await within(received.promise, 'server sendMsg'), 'ordinary');
    assert.deepStrictEqual(await within(peer().asendCallback(910201, 21), 'server asendCallback'), [ErrorEnum.ErrorOk, 42]);
});

test('RPC to an unknown server connection returns a result tuple', async context => {
    const { server } = await createIOPair(context);
    assert.deepStrictEqual(await server.asendMod(999999, NetEventEnum.eventCallback, [910202]),
        [ErrorEnum.Net_notconnect, null]);
});

for (const explicit of [true, false]) {
    test(`server automatically expires ${explicit ? 'explicit' : 'default'} RPC timeouts`, async context => {
        const { client, connect, peer } = await createIOPair(context, {}, {}, { checktimeout: true, checkIntervalMs: 5 });
        client.onCallback(910203, () => new Promise(() => {}));
        await connect();
        const socket = peer();
        socket.session.timeoutMax = 10;
        assert.deepStrictEqual(await within(socket.asendMod('cb', [910203], explicit ? 10 : 0), 'server RPC timeout'),
            [ErrorEnum.Callback_timeout]);
        assert.deepStrictEqual(socket.session.callbacks, {});
        client.onCallback(910203, () => [ErrorEnum.ErrorOk, 'healthy']);
        assert.deepStrictEqual(await within(socket.asendCallback(910203), 'RPC after timeout'), [ErrorEnum.ErrorOk, 'healthy']);
    });
}

test('server timeout polling uses one unref timer and releases it on close/relisten', async context => {
    const server = new IOServer('timer-test', createSliceLogger(), { checktimeout: true });
    context.after(() => server.close());
    const timers: NodeJS.Timeout[] = [];
    const cleared: NodeJS.Timeout[] = [];
    const set = global.setInterval;
    const clear = global.clearInterval;
    context.mock.method(global, 'setInterval', (handler: () => void, ms: number) => {
        const timer = set(handler, ms);
        if (ms === 1000) timers.push(timer);
        return timer;
    });
    context.mock.method(global, 'clearInterval', (timer: NodeJS.Timeout) => {
        if (timers.includes(timer)) cleared.push(timer);
        clear(timer);
    });
    assert.deepStrictEqual(await server.listen(0), [true]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].hasRef(), false);
    assert.deepStrictEqual(await server.listen(0), [true]);
    assert.deepStrictEqual(cleared, [timers[0]]);
    assert.equal(timers.length, 2);
    server.close();
    server.close();
    assert.deepStrictEqual(cleared, timers);
});

for (const param of [undefined, {}, { checktimeout: false }]) {
    test(`server does not check RPC timeouts when disabled: ${JSON.stringify(param)}`, async context => {
        const server = new IOServer('disabled-timeouts', createSliceLogger(), param);
        context.after(() => server.close());
        const intervals = context.mock.method(global, 'setInterval');
        assert.deepStrictEqual(server.param, param ?? {});
        assert.deepStrictEqual(await server.listen(0), [true]);
        // 只创建传输层心跳，不应额外创建 RPC 检查定时器。
        assert.deepStrictEqual(intervals.mock.calls.map(call => call.arguments[1]), [10000]);
    });
}

for (const checkIntervalMs of [5, 0, -1, NaN, Infinity]) {
    test(`server timeout interval validates configuration: ${checkIntervalMs}`, async context => {
        const server = new IOServer('configured-timeouts', createSliceLogger(), { checktimeout: true, checkIntervalMs });
        context.after(() => server.close());
        const intervals = context.mock.method(global, 'setInterval');
        assert.deepStrictEqual(await server.listen(0), [true]);
        assert.deepStrictEqual(intervals.mock.calls.map(call => call.arguments[1]), [10000, checkIntervalMs === 5 ? 5 : 1000]);
    });
}
