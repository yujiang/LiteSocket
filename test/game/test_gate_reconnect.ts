import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ErrorEnum } from '../../src/client';
import { game2gate_info_error } from '../../src/game/ErrorGame';
import { GameGate } from '../../src/game/game/GameGate';
import { GateServer } from '../../src/game/gate/GateServer';
import { MsgGameGateEnum } from '../../src/game/MsgGame';
import { createLogger } from '../logger_helpers';
import { deferred } from '../io_test_helpers';
import { unusedAddress, waitUntil, within } from '../lite_test_helpers';

function setup(context: TestContext) {
    const logger = createLogger({ silent: true });
    const gate = new GateServer(10, logger, logger);
    const game = new GameGate(100, logger, { checktimeout: true, checkIntervalMs: 5 },
        { backoff: { baseMs: 20, maxMs: 20, jitter: 0 } });
    const notifications: number[] = [];
    game.onRegistedId = code => { notifications.push(code); };
    context.after(() => {
        game.destroy('test cleanup');
        gate.games.close();
        gate.clients.close();
        logger.close();
    });
    return { gate, game, notifications };
}

test('GameGate re-registers after connection loss and notifies once per attempt', async context => {
    const { gate, game, notifications } = setup(context);
    assert.deepStrictEqual(await gate.games.listen(0), [true]);
    assert.equal(await within(game.start(`ws://127.0.0.1:${gate.games.io.port}`), 'registration'), ErrorEnum.ErrorOk);
    const old = gate.games.findGame(game.id);
    assert(old);
    old.terminate();
    await waitUntil(() => notifications.length >= 2 && !!gate.games.findGame(game.id), 're-registration');
    const current = gate.games.findGame(game.id);
    assert.notEqual(current.id, old.id);
    assert.deepStrictEqual(notifications, [ErrorEnum.ErrorOk, ErrorEnum.ErrorOk]);
    assert.equal(await game.asendCallbacke(MsgGameGateEnum.game2gate_info, 200),
        game2gate_info_error.Socket_already_registered);
    assert.equal(gate.games.findGame(200), undefined);
    assert.equal(gate.games.findGame(100), current);
    assert.deepStrictEqual(game.callback.callbacks, {});
});

test('GameGate registers when automatic reconnect recovers its initial connection failure', async context => {
    const { gate, game, notifications } = setup(context);
    const { port, url } = await unusedAddress(context);
    assert.equal(await within(game.start(url), 'initial connection failure'), ErrorEnum.Net_notconnect);
    assert.deepStrictEqual(await gate.games.listen(port), [true]);
    await waitUntil(() => !!gate.games.findGame(game.id), 'registration after initial failure');
    await waitUntil(() => notifications.length > 0, 'registration notification');
    assert.deepStrictEqual(notifications, [ErrorEnum.ErrorOk]);
});

test('registration conflicts retry to success with one notification per attempt', async context => {
    const { game, notifications } = setup(context);
    const conflict = game2gate_info_error.Game_already_registered;
    const success = deferred<number>();
    context.after(() => success.resolve(ErrorEnum.ErrorOk));
    let attempts = 0;
    context.mock.method(game, 'asendCallbacke', async () => ++attempts === 1 ? conflict : success.promise);
    let settled = false;
    const pending = game.continueSendId(59).then(() => { settled = true; });
    await waitUntil(() => attempts === 2, 'final registration request');
    assert.equal(settled, false, 'the retry chain must await the final response');
    success.resolve(ErrorEnum.ErrorOk);
    await within(pending, 'conflict retry');
    assert.equal(attempts, 2, 'the retry promise includes the final attempt');
    assert.deepStrictEqual(notifications, [conflict, ErrorEnum.ErrorOk]);
});

test('registration retry limit makes no further attempt', async context => {
    const { game, notifications } = setup(context);
    const conflict = game2gate_info_error.Game_already_registered;
    const send = context.mock.method(game, 'asendCallbacke', async () => conflict);
    await game.continueSendId(60);
    assert.equal(send.mock.callCount(), 1);
    assert.deepStrictEqual(notifications, [conflict]);
});

test('destroy cancels a pending registration retry', async context => {
    const { game, notifications } = setup(context);
    const conflict = game2gate_info_error.Game_already_registered;
    const send = context.mock.method(game, 'asendCallbacke', async () => conflict);
    const pending = game.continueSendId(0);
    await waitUntil(() => notifications.length > 0, 'conflict received');
    game.destroy('stop registration');
    await within(pending, 'cancelled registration');
    await delay(1050);
    assert.equal(send.mock.callCount(), 1);
    assert.deepStrictEqual(notifications, [conflict]);
});

test('a newer registration attempt suppresses stale results from the previous connection', async context => {
    const { game, notifications } = setup(context);
    const stale = deferred<number>();
    context.after(() => stale.resolve(ErrorEnum.ErrorOk));
    let calls = 0;
    context.mock.method(game, 'asendCallbacke', () => ++calls === 1 ? stale.promise : Promise.resolve(ErrorEnum.ErrorOk));
    const previous = game.continueSendId(0);
    await game.continueSendId(0);
    stale.resolve(game2gate_info_error.Game_already_registered);
    await within(previous, 'superseded registration');
    assert.equal(calls, 2);
    assert.deepStrictEqual(notifications, [ErrorEnum.ErrorOk]);
});

test('disconnect cancels the registration delay before the next connection', async context => {
    const { game, notifications } = setup(context);
    const conflict = game2gate_info_error.Game_already_registered;
    const send = context.mock.method(game, 'asendCallbacke', async () => conflict);
    const pending = game.continueSendId(0);
    await waitUntil(() => notifications.length > 0, 'registration conflict');
    game.onDisconnect('test disconnect');
    await within(pending, 'disconnected registration');
    await delay(1050);
    assert.equal(send.mock.callCount(), 1);
    assert.deepStrictEqual(notifications, [conflict]);
});

test('registration errors other than duplicate game ids are not retried', async context => {
    const { game, notifications } = setup(context);
    const code = game2gate_info_error.Socket_already_registered;
    const send = context.mock.method(game, 'asendCallbacke', async () => code);
    await game.continueSendId(0);
    assert.equal(send.mock.callCount(), 1);
    assert.deepStrictEqual(notifications, [code]);
});
