import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LiteClient } from '../../src/net/LiteClient';
import { ClientSession } from '../../src/net/ClientSession';
import { ErrorEnum } from '../../src/net/ErrorEnum';
import { SessionCallback } from '../../src/net/SessionCallback';
import { createSliceLogger } from '../../src/public/log';

test('RPC elapsed time ignores wall-clock adjustments', async context => {
    let monotonic = 1000;
    let wall = 1700000000000;
    context.mock.method(performance, 'now', () => monotonic);
    context.mock.method(Date, 'now', () => wall);
    const session = new ClientSession('clock-test', createSliceLogger());
    session.resetSocket({ connected: true, emit() {} });
    context.after(() => { session.reset(ErrorEnum.Callback_disconnect, false); session.close(); });
    const request = session.asendMod('cb', [1], 100);
    assert.equal(session.callbacks[1][3], 1000);
    wall += 86400000;
    monotonic = 1050;
    assert.equal(session.checkTimeout(SessionCallback.getTime()), 0);
    wall -= 172800000;
    monotonic = 1101;
    assert.equal(session.checkTimeout(SessionCallback.getTime()), 1);
    assert.deepStrictEqual(await request, [ErrorEnum.Callback_timeout]);
});

test('heartbeat age and RTT use the local monotonic clock, not wall time or peer clock', context => {
    let now = 1000;
    context.mock.method(performance, 'now', () => now);
    context.mock.method(Date, 'now', () => 9999999999999);
    const client = new LiteClient('clock-test', createSliceLogger());
    context.after(() => client.destroy());
    assert.equal(client.lastPong, 1000);
    client.onPong([950, 1]);
    assert.equal(client.getArgDelay(), 25);
    now = 1050;
    client.onPong([1000, 9999999999999]);
    assert.equal(client.getArgDelay(), 25);
    assert.equal(client.heartBreak(1150, 100), '');
    assert.equal(client.heartBreak(1151, 100), 'pong-timeout');
    context.mock.method(client, 'isConnected', () => true);
    const send = context.mock.method(client, 'emit', () => true);
    client.onPing(123);
    assert.deepStrictEqual(send.mock.calls[0].arguments, ['pong', [123, 1050]]);
});
