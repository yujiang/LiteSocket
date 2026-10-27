import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { LiteLogger } from '../../src/public/log';
import { connect, createClient, createLiteServer, waitUntil } from '../lite_test_helpers';

function createObserveLogger() {
    const entries: Array<{ level: string, args: unknown[] }> = [];
    const logger: LiteLogger = {
        info: (...args) => { entries.push({ level: 'info', args }); },
        log: (...args) => { entries.push({ level: 'info', args }); },
        warn: (...args) => { entries.push({ level: 'warn', args }); },
        error: (...args) => { entries.push({ level: 'error', args }); },
        debug: (...args) => { entries.push({ level: 'debug', args }); },
    };
    return { logger, entries };
}

test('observe logs only the selected client messages without blocking handlers', async context => {
    const { server, url } = await createLiteServer(context);
    const observedClient = createClient(context);
    const otherClient = createClient(context);
    await connect(observedClient, url);
    await connect(otherClient, url);

    const handled: Array<[number, unknown]> = [];
    server.onMessage('observe-probe', (peer, data) => handled.push([peer.id, data]));
    const { logger, entries } = createObserveLogger();

    assert.equal(server.observe(999999, logger), false);
    assert.equal(server.observe(observedClient.getServerId(), logger), true);

    const observedPayload = { value: 'observed' };
    observedClient.emit('observe-probe', observedPayload);
    otherClient.emit('observe-probe', { value: 'not observed' });

    await waitUntil(() => handled.length === 2, 'both observed and unobserved messages handled');
    assert.deepStrictEqual(handled, [
        [observedClient.getServerId(), observedPayload],
        [otherClient.getServerId(), { value: 'not observed' }],
    ]);
    assert.deepStrictEqual(entries, [{
        level: 'debug',
        args: ['[observe]', observedClient.getServerId(), 'observe-probe', observedPayload],
    }]);

    server.kickoff(observedClient.getServerId());
    await observedClient.events.waitForCount('close', 1);
    await waitUntil(() => !server.findById(observedClient.getServerId()), 'observed client removal');
    assert.equal(server.observe(observedClient.getServerId(), logger), false);
});
