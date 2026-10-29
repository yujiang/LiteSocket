import { test } from 'node:test';
import { LiteSocket, SocketReason } from '../../src/net/LiteSocket';
import { connect, createClient, createLiteServer, waitUntil, within } from '../lite_test_helpers';
import { strict as assert } from 'node:assert';
import { createIOPair } from '../io_test_helpers';
import { LiteServerClient } from '../../src/net/LiteServerClient';

function get_baddata(){
    const data : any = {a: 1, func:()=>{console.log("hello")}, c:"c"} 
    data.data = data;
    return data;
}

function run(){
    const msg = LiteSocket.encodeMessage("test", get_baddata());
    console.log(msg)
}

function createPromise(){
    let rv: any;
    const p = new Promise(resolve=>{rv = resolve;});
    return [p,rv];
}

// 实际操作不要onEvent("exception") 会冲掉本来的"exception", 只是为了test

test('LiteClient emit baddata', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    await connect(client, url);

    const [p,rv] = createPromise();
    client.onEvent("exception", (resaon: SocketReason, err?: any) => {
        console.log("LiteClient onEvent exception", resaon, err)
        rv(resaon)
    })
    client.emit('baddata', get_baddata());
    const reason = await p;
    assert.equal(reason, 'JSON.stringify error');
});

test('LiteServer broadcast baddata', async context => {
    const { server, url } = await createLiteServer(context);

    const [p,rv] = createPromise();
    server.onEvent("exception", (resaon: SocketReason, err?: any) => {
        console.log("LiteServer onEvent exception", resaon, err)
        rv(resaon)
    })
    server.broadcast('baddata', get_baddata());
    const reason = await p;
    assert.equal(reason, 'JSON.stringify error');
});

test('LiteServerClient emit baddata', async context => {
    const { server, url } = await createLiteServer(context);
    const client = createClient(context);
    await connect(client, url);

    const [p,rv] = createPromise();
    server.onClient("exception", (client: LiteServerClient, resaon: SocketReason, err?: any) => {
        console.log("LiteServerClient onEvent exception", resaon, err)
        rv(resaon)
    })
    const peer = server.findById(client.serverId);
    assert(peer);
    peer.emit('baddata', get_baddata());
    const reason = await p;
    assert.equal(reason, 'JSON.stringify error');
});


test('IOClient sendMsg baddata', async context => {
    const { server, client, connect, peer, barrier, errors } = await createIOPair(context);
    await connect();

    const [p,rv] = createPromise();
    client.socket.onEvent("exception", (resaon: SocketReason, err?: any) => {
        console.log("IOClient onEvent exception", resaon, err)
        rv(resaon)
    })
    client.sendMsg(1, 'baddata', get_baddata());
    const reason = await p;
    assert.equal(reason, 'JSON.stringify error');
});

test('IOServerSocket sendMsg baddata', async context => {
    const { server, client, connect, peer, barrier, errors } = await createIOPair(context);
    await connect();

    const [p,rv] = createPromise();
    server.io.onClient("exception", (client: LiteServerClient, resaon: SocketReason, err?: any) => {
        console.log("IOServerSocket onEvent exception", resaon, err)
        rv(resaon)
    })
    peer().sendMsg(1, 'baddata', get_baddata());
    const reason = await p;
    assert.equal(reason, 'JSON.stringify error');
});

// run()