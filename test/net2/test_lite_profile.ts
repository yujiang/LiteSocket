// profile 耗时日志：达到全局超时输出 error；否则超过 printms 输出 info。
// 使用模拟时钟覆盖边界，避免忙等或依赖机器负载。
import { strict as assert } from 'node:assert';
import { test, TestContext } from 'node:test';
import type { LiteLogger } from '../../src/public/log';
import type { msgData } from '../../src/public/Depends';
import { CostGuards, profileCallCost, setProfileLogger } from '../../src/public/profile';
import * as call from '../../src/public/call';
import { ErrorEnum } from '../../src/net/ErrorEnum';
import { MsgHandleCB, SocketParamEnum } from '../../src/net/msg';
import { NetEventEnum } from '../../src/net/msgid';
import { createLogger } from '../logger_helpers';

function setupProfile(context: TestContext, timeout = 1000) {
    const entries: Array<{ level: string, args: unknown[] }> = [];
    const logger: LiteLogger = {
        info: (...args) => { entries.push({ level: 'info', args }); },
        warn: (...args) => { entries.push({ level: 'warn', args }); },
        error: (...args) => { entries.push({ level: 'error', args }); },
        debug: (...args) => { entries.push({ level: 'debug', args }); },
        log: (...args) => { entries.push({ level: 'log', args }); },
    };
    let now = 100;
    context.mock.method(performance, 'now', () => now);
    setProfileLogger(logger, timeout);
    context.after(() => setProfileLogger(console));
    return { entries, advance: (ms: number) => { now += ms; } };
}

const thresholds = [
    { cost: 9, level: undefined },
    { cost: 10, level: undefined }, // printms 使用严格大于。
    { cost: 10.25, level: 'info' },
    { cost: 999, level: 'info' },
    { cost: 1000, level: 'error' }, // timeout 包含相等边界。
    { cost: 1200, level: 'error' },
];

for (const { cost, level } of thresholds) {
    test(`profile cost ${cost}ms: ${level ?? 'no log'} (printms=10, timeout=1000)`, context => {
        const { entries, advance } = setupProfile(context);
        const guards = new CostGuards('profile-test');
        guards.setProfile(true, 10);
        const guard = guards.findGuard('slow-handler');
        const self = { offset: 2 };
        function handler(this: typeof self, value: number, tag: string) {
            assert.equal(this, self);
            assert.equal(tag, 'request-tag');
            advance(cost);
            return this.offset + value;
        }
        assert.equal(guard.tryCall(handler, self, [3, 'request-tag']), 5);
        assert.equal(guard.called, 1);
        assert.equal(guard.mscost, cost);
        assert.equal(guard.percost(), cost);
        assert.equal(guard.error, 0);
        if (!level) {
            assert.deepStrictEqual(entries, []);
        } else {
            assert.deepStrictEqual(entries, [{
                level,
                args: ['profile cost ', 100, 'slow-handler', 'request-tag',
                    level === 'error' ? `${(cost / 1000).toFixed(1)}s` : `${cost.toFixed(1)}ms`,
                    level === 'error' ? String(handler) : handler.name],
            }]);
        }
    });
}

test('custom timeout takes priority even when printms is higher', context => {
    const { entries, advance } = setupProfile(context, 25);
    const guards = new CostGuards('custom-timeout');
    guards.setProfile(true, 100);
    const guard = guards.findGuard('handler');
    guard.tryCall(() => { advance(25); }, null, []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, 'error');
    assert.equal(guard.mscost, 25);
});

test('profile disabled preserves handler results without timing or cost logs', context => {
    const { entries, advance } = setupProfile(context);
    const guards = new CostGuards('disabled');
    const guard = guards.findGuard('handler');
    assert.equal(guards.profile, false);
    const result = { value: 'unchanged' };
    assert.equal(guard.tryCall(() => { advance(2000); return result; }, null, []), result);
    assert.equal(guard.called, 1);
    assert.equal(guard.mscost, 0);
    assert.equal(guard.percost(), 0);
    assert.deepStrictEqual(entries, []);
});

test('toggling profile keeps call counts and accumulated cost consistent', context => {
    const { entries, advance } = setupProfile(context);
    const guards = new CostGuards('toggle');
    const guard = guards.findGuard('handler');
    assert.equal(guard.percost(), 0);
    assert.equal(guards.findGuard('handler'), guard);
    guards.setProfile(true, 100);
    for (const cost of [20, 40]) guard.tryCall(() => { advance(cost); }, null, []);
    assert.equal(guard.called, 2);
    assert.equal(guard.mscost, 60);
    assert.equal(guard.percost(), 30);
    guards.setProfile(false);
    guard.tryCall(() => { advance(2000); }, null, []);
    assert.equal(guard.called, 3);
    assert.equal(guard.mscost, 60);
    assert.equal(guard.percost(), 20);
    assert.deepStrictEqual(entries, []);
});

for (const enabled of [false, true]) {
    test(`profile=${enabled}: synchronous exceptions remain isolated and counted`, context => {
        const { entries, advance } = setupProfile(context);
        const exceptions = context.mock.method(call, 'logExceptionArgs', () => {});
        const guards = new CostGuards('exceptions');
        guards.setProfile(enabled);
        const guard = guards.findGuard('throw-handler');
        const error = new Error('handler failed');
        const self = { id: 42 };
        const args = ['request'];
        assert.equal(guard.tryCall(() => { advance(1200); throw error; }, self, args), null);
        assert.equal(guard.called, 1);
        assert.equal(guard.error, 1);
        assert.equal(guard.mscost, 0);
        assert.equal(exceptions.mock.callCount(), 1);
        assert.deepStrictEqual(exceptions.mock.calls[0].arguments,
            ['try_call_data throw-handler', error, args, 42]);
        assert.deepStrictEqual(entries, []);
        assert.equal(guard.tryCall(() => 'healthy', null, []), 'healthy');
        assert.equal(guard.called, 2);
        assert.equal(guard.error, 1);
    });
}

test('profileCallCost preserves this, arguments and result', context => {
    const { advance } = setupProfile(context);
    const self = { value: 3 };
    const result = { healthy: true };
    const measured = profileCallCost(function(this: typeof self, value: number) {
        assert.equal(this, self);
        assert.equal(value, 7);
        advance(12.5);
        return result;
    }, self, [7]);
    assert.deepStrictEqual(measured, [100, 12.5, result]);
});

for (const cost of [20, 1000]) {
    test(`RPC dispatcher profiles synchronous handler (${cost}ms) without changing reply`, async context => {
        const { entries, advance } = setupProfile(context);
        const handle = new MsgHandleCB('rpc-profile', createLogger());
        handle.setProfile(true, 10);
        const id = 930001;
        handle.register(id, (value: number) => {
            advance(cost);
            return [ErrorEnum.ErrorOk, value + 1];
        }, null, SocketParamEnum.noSocket, 'profile-test');
        const replies: Array<{ event: string, data: msgData }> = [];
        assert(await handle.handleMsg({ emit(event, data) { replies.push({ event, data }); } }, [id, 7, 101]));
        assert.deepStrictEqual(replies, [{ event: NetEventEnum.eventCallbacked, data: [101, [ErrorEnum.ErrorOk, 8]] }]);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].level, cost === 1000 ? 'error' : 'info');
        const guard = handle.getHandle(id);
        assert.equal(entries[0].args[2], guard.name);
        assert.equal(guard.called, 1);
        assert.equal(guard.mscost, cost);
        assert.equal(guard.error, 0);
    });
}
