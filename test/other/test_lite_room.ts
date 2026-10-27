// 使用net/lite模块, 测试room功能

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test, TestContext } from 'node:test';
import { RoomManager } from '../../src/net/LiteRoom';
import {
    connect, createClient, createLiteServer, LiteServerTest,
    LiteClientTest, waitUntil, within,
} from '../lite_test_helpers';

async function createRoomClients(context: TestContext, count = 3) {
    const { server, url } = await createLiteServer(context);
    const members = await Promise.all(Array.from({ length: count }, async () => {
        const client = createClient(context);
        const messages: string[] = [];
        const barriers: number[] = [];
        client.on('room-message', data => messages.push(data));
        client.on('barrier', data => barriers.push(data));
        await connect(client, url);
        const peer = server.findById(client.getServerId());
        assert(peer);
        return { client, peer, messages, barriers };
    }));
    return { server, members };
}

// 广播后向每个待检查的客户端发送一个标记；同一连接按序收包，标记到达就说明之前的广播已处理。
// 标记用独立事件记录，不会混入业务消息，因此可以可靠断言“不该收到的广播确实没收到”。
async function flushMessages(server: LiteServerTest, members: Array<{ barriers: number[] }>) {
    const counts = members.map(member => member.barriers.length + 1);
    server.broadcast('barrier', 1);
    await waitUntil(() => members.every((member, index) => member.barriers.length >= counts[index]), 'broadcast barriers');
}

async function waitForClosed(server: LiteServerTest, client: LiteClientTest, serverCloseCount: number) {
    await Promise.all([
        client.events.waitForCount('close', 1),
        server.events.waitForCount('client-close', serverCloseCount),
    ]);
}

// 查询、离开或解散一个不存在的房间，都不应自动创建房间，也不应影响已有连接。
test('operations on missing rooms do not create rooms', async context => {
    const { server, members: [member] } = await createRoomClients(context, 1);
    assert.equal(server.getRoom('missing'), undefined);
    assert.doesNotThrow(() => server.leaveRoom('missing', member.peer));
    assert.doesNotThrow(() => server.dismissRoom('missing'));
    assert.equal(server.getRoom('missing'), undefined);
    assert(member.client.isConnected());
});

// 首次加入时自动建房；重复加入同一个成员不重复计数，成员枚举也只出现一次。
test('joining creates a room and duplicate joins are idempotent', async context => {
    const { server, members: [member] } = await createRoomClients(context, 1);
    server.joinRoom('main', member.peer);
    const room = server.getRoom('main');
    assert(room);
    server.joinRoom('main', member.peer);
    assert.equal(server.getRoom('main'), room);
    assert.equal(room.name, 'main');
    assert.equal(room.size(), 1);
    assert(!room.isEmpty());
    assert(room.has(member.peer));
    assert.deepStrictEqual(Array.from(room.getClients()), [member.peer]);
});

// 同一客户端可以加入多个房间；各房间独立维护成员，重复加入一个房间不能改变另一个房间。
test('one client can join multiple independent rooms', async context => {
    const { server, members: [first, second] } = await createRoomClients(context, 2);
    server.joinRoom('alpha', first.peer);
    server.joinRoom('beta', first.peer);
    server.joinRoom('alpha', second.peer);
    server.joinRoom('beta', first.peer);
    assert.deepStrictEqual(Array.from(server.getRoom('alpha').getClients()), [first.peer, second.peer]);
    assert.deepStrictEqual(Array.from(server.getRoom('beta').getClients()), [first.peer]);
    assert(!server.getRoom('beta').has(second.peer));
});

// 离开非成员或重复离开都无副作用；最后一个成员离开后，空房间应从管理器删除。
// 再次加入同名房间时，应创建一个新的房间对象，不能沿用旧房间的成员状态。
test('leaving is idempotent and the last member removes the room', async context => {
    const { server, members: [first, second, outsider] } = await createRoomClients(context);
    server.joinRoom('main', first.peer);
    server.joinRoom('main', second.peer);
    const room = server.getRoom('main');
    server.leaveRoom('main', outsider.peer);
    assert.equal(room.size(), 2);
    server.leaveRoom('main', first.peer);
    server.leaveRoom('main', first.peer);
    assert.equal(room.size(), 1);
    assert(!room.has(first.peer));
    assert(room.has(second.peer));
    server.leaveRoom('main', second.peer);
    assert(room.isEmpty());
    assert.equal(server.getRoom('main'), undefined);
    server.joinRoom('main', outsider.peer);
    assert.notEqual(server.getRoom('main'), room);
    assert.deepStrictEqual(Array.from(server.getRoom('main').getClients()), [outsider.peer]);
});

// 房间广播只能发送给房间成员；重复加入的成员也只能收到一份，房间外的在线客户端不能收到。
test('room broadcast reaches each member once and excludes outsiders', async context => {
    const { server, members } = await createRoomClients(context);
    const [first, second, outsider] = members;
    server.joinRoom('main', first.peer);
    server.joinRoom('main', first.peer);
    server.joinRoom('main', second.peer);
    server.getRoom('main').broadcast('room-message', 'main');
    await flushMessages(server, members);
    assert.deepStrictEqual(first.messages, ['main']);
    assert.deepStrictEqual(second.messages, ['main']);
    assert.deepStrictEqual(outsider.messages, []);
});

// 两个房间可以有重叠成员，但广播不能串房；重叠成员分别收到两个房间各自的一条消息。
test('overlapping rooms broadcast independently', async context => {
    const { server, members } = await createRoomClients(context);
    const [shared, alphaOnly, betaOnly] = members;
    server.joinRoom('alpha', shared.peer);
    server.joinRoom('alpha', alphaOnly.peer);
    server.joinRoom('beta', shared.peer);
    server.joinRoom('beta', betaOnly.peer);
    server.getRoom('alpha').broadcast('room-message', 'alpha');
    server.getRoom('beta').broadcast('room-message', 'beta');
    await flushMessages(server, members);
    assert.deepStrictEqual(shared.messages, ['alpha', 'beta']);
    assert.deepStrictEqual(alphaOnly.messages, ['alpha']);
    assert.deepStrictEqual(betaOnly.messages, ['beta']);
});

// exceptClient 指定房间成员时只排除该成员；指定房间外的客户端时，不应误排除任何成员。
test('room broadcast excludes only the specified member', async context => {
    const { server, members } = await createRoomClients(context);
    const [first, second, outsider] = members;
    server.joinRoom('main', first.peer);
    server.joinRoom('main', second.peer);
    const room = server.getRoom('main');
    room.broadcast('room-message', 'except-first', first.peer);
    room.broadcast('room-message', 'all-members', outsider.peer);
    await flushMessages(server, members);
    assert.deepStrictEqual(first.messages, ['all-members']);
    assert.deepStrictEqual(second.messages, ['except-first', 'all-members']);
    assert.deepStrictEqual(outsider.messages, []);
});

// 主动退出其中一个房间后，不再接收该房间广播，但仍可接收另一个房间的广播，连接保持正常。
test('leaving one room preserves membership in another room', async context => {
    const { server, members } = await createRoomClients(context);
    const [first, second, outsider] = members;
    server.joinRoom('alpha', first.peer);
    server.joinRoom('alpha', second.peer);
    server.joinRoom('beta', first.peer);
    server.leaveRoom('alpha', first.peer);
    server.getRoom('alpha').broadcast('room-message', 'alpha');
    server.getRoom('beta').broadcast('room-message', 'beta');
    await flushMessages(server, members);
    assert.deepStrictEqual(first.messages, ['beta']);
    assert.deepStrictEqual(second.messages, ['alpha']);
    assert.deepStrictEqual(outsider.messages, []);
    assert(first.client.isConnected());
});

// 全服广播独立于房间：过滤器可只选一个客户端，不带过滤器时包括房间外的在线客户端。
test('server broadcast honors its filter without restricting recipients to a room', async context => {
    const { server, members } = await createRoomClients(context);
    const [first, second, outsider] = members;
    server.joinRoom('main', first.peer);
    server.joinRoom('main', second.peer);
    server.broadcast('room-message', 'filtered', peer => peer.id === second.peer.id);
    server.broadcast('room-message', 'everyone');
    await flushMessages(server, members);
    assert.deepStrictEqual(first.messages, ['everyone']);
    assert.deepStrictEqual(second.messages, ['filtered', 'everyone']);
    assert.deepStrictEqual(outsider.messages, ['everyone']);
});

// LiteClient.broadcastNotSelf 是全服范围的“排除自己”，不是只向自己所在的房间广播。
test('client broadcastNotSelf reaches other clients including room outsiders', async context => {
    const { server, members } = await createRoomClients(context);
    const [sender, sameRoom, outsider] = members;
    server.joinRoom('main', sender.peer);
    server.joinRoom('main', sameRoom.peer);
    sender.peer.broadcastNotSelf('room-message', 'others');
    await flushMessages(server, members);
    assert.deepStrictEqual(sender.messages, []);
    assert.deepStrictEqual(sameRoom.messages, ['others']);
    assert.deepStrictEqual(outsider.messages, ['others']);
});

// 解散后不能再通过服务器查询到旧房间；重新加入同名房间只包含新成员，其他房间不受影响。
test('dismissed room can be recreated without inheriting former members', async context => {
    const { server, members } = await createRoomClients(context);
    const [first, second, newcomer] = members;
    server.joinRoom('main', first.peer);
    server.joinRoom('main', second.peer);
    server.joinRoom('other', first.peer);
    const original = server.getRoom('main');
    server.dismissRoom('main');
    assert.equal(server.getRoom('main'), undefined);
    server.dismissRoom('main');
    server.joinRoom('main', newcomer.peer);
    const recreated = server.getRoom('main');
    assert.notEqual(recreated, original);
    assert.deepStrictEqual(Array.from(recreated.getClients()), [newcomer.peer]);
    recreated.broadcast('room-message', 'new-main');
    server.getRoom('other').broadcast('room-message', 'other');
    await flushMessages(server, members);
    assert.deepStrictEqual(first.messages, ['other']);
    assert.deepStrictEqual(second.messages, []);
    assert.deepStrictEqual(newcomer.messages, ['new-main']);
});

for (const mode of ['disconnect', 'terminate'] as const) {
    // 正常断开和强制断开都应自动退出全部房间：独占房间删除，共享房间只移除断开的成员。
    // 等两端 close 后再检查，避免把仍在关闭握手中的连接误判为没有清理。
    test(`${mode} removes the client from every room and deletes empty rooms`, async context => {
        const { server, members } = await createRoomClients(context);
        const [departing, remaining, outsider] = members;
        server.joinRoom('shared', departing.peer);
        server.joinRoom('shared', remaining.peer);
        server.joinRoom('solo', departing.peer);
        server.joinRoom('remaining-only', remaining.peer);
        const shared = server.getRoom('shared');
        const solo = server.getRoom('solo');
        if (mode === 'disconnect') departing.client.disconnect();
        else departing.peer.terminate();
        await waitForClosed(server, departing.client, 1);
        assert.equal(server.findById(departing.peer.id), undefined);
        assert.equal(server.getRoom('solo'), undefined);
        assert(solo.isEmpty());
        assert(!shared.has(departing.peer));
        assert.deepStrictEqual(Array.from(shared.getClients()), [remaining.peer]);
        assert.equal(server.getRoom('remaining-only').size(), 1);
        shared.broadcast('room-message', 'survivor');
        await flushMessages(server, [remaining, outsider]);
        assert.deepStrictEqual(remaining.messages, ['survivor']);
        assert.deepStrictEqual(outsider.messages, []);
        server.leaveRoom('shared', remaining.peer);
        assert.equal(server.getRoom('shared'), undefined);
        assert.equal(server.getRoom('remaining-only').size(), 1);
    });
}

// 服务端发起关闭后，socket 会先进入 CLOSING，成员尚未从房间删除，此时广播也应跳过它。
// 用发送方法的调用记录确认没有尝试向关闭中的 socket 写入，其他成员仍正常收到广播。
test('broadcast skips a member whose socket is already closing', async context => {
    const { server, members } = await createRoomClients(context);
    const [closing, remaining, outsider] = members;
    server.joinRoom('main', closing.peer);
    server.joinRoom('main', remaining.peer);
    const send = context.mock.method(closing.peer, 'wsSend');
    closing.peer.disconnect();
    assert(!closing.peer.isConnected());
    assert(server.getRoom('main').has(closing.peer));
    server.getRoom('main').broadcast('room-message', 'online-only');
    await flushMessages(server, [remaining, outsider]);
    assert.equal(send.mock.callCount(), 0);
    assert.deepStrictEqual(remaining.messages, ['online-only']);
    assert.deepStrictEqual(outsider.messages, []);
    await waitForClosed(server, closing.client, 1);
});

// 关闭整个服务器时，所有连接的 close 都应清理房间成员，最终不再保留任何非空房间。
test('server shutdown removes all connected clients from rooms', async context => {
    const { server, members } = await createRoomClients(context);
    for (const member of members) server.joinRoom('main', member.peer);
    server.joinRoom('solo', members[0].peer);
    const main = server.getRoom('main');
    const solo = server.getRoom('solo');
    const closed = once(server.wss, 'close');
    server.close();
    await within(closed, 'server shutdown');
    await Promise.all(members.map(member => member.client.events.waitForCount('close', 1)));
    assert.equal(server.clientsNum(), 0);
    assert.equal(server.getRoom('main'), undefined);
    assert.equal(server.getRoom('solo'), undefined);
    assert(main.isEmpty());
    assert(solo.isEmpty());
});

// 直接覆盖 RoomManager 的建房、查询、枚举和解散接口；重复创建同名房间返回同一对象。
// 空房间广播应安全地不发送任何消息，解散不存在的房间也不影响其他房间。
test('room manager creates, enumerates and dismisses rooms idempotently', async context => {
    const { server, members } = await createRoomClients(context, 1);
    const manager = new RoomManager(server);
    assert.equal(manager.get('alpha'), undefined);
    assert(!manager.has('alpha'));
    const alpha = manager.create('alpha');
    const beta = manager.create('beta');
    assert.equal(manager.create('alpha'), alpha);
    assert(manager.has('alpha'));
    assert(alpha.isEmpty());
    assert.deepStrictEqual(Array.from(manager.getAllRooms()), [alpha, beta]);
    assert.doesNotThrow(() => alpha.broadcast('room-message', 'nobody'));
    await flushMessages(server, members);
    assert.deepStrictEqual(members[0].messages, []);
    manager.dismiss('missing');
    manager.dismiss('alpha');
    assert(!manager.has('alpha'));
    assert.deepStrictEqual(Array.from(manager.getAllRooms()), [beta]);
});

// RoomManager.leaveAll 应一次性清除某成员的全部房间关系，同时保留仍有其他成员的房间。
// 再清理最后一个成员后，房间枚举应为空，重复清理也不应抛异常。
test('room manager leaveAll removes only the selected client and cleans empty rooms', async context => {
    const { server, members: [first, second] } = await createRoomClients(context, 2);
    const manager = new RoomManager(server);
    manager.join('solo', first.peer);
    manager.join('shared', first.peer);
    manager.join('shared', second.peer);
    manager.leaveAll(first.peer);
    assert(!manager.has('solo'));
    assert.deepStrictEqual(Array.from(manager.get('shared').getClients()), [second.peer]);
    manager.leaveAll(first.peer);
    assert.equal(manager.get('shared').size(), 1);
    manager.leaveAll(second.peer);
    assert.deepStrictEqual(Array.from(manager.getAllRooms()), []);
});
