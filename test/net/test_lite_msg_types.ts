import type { IOClient } from '../../src/net/IOClient';
import type { IOServer } from '../../src/net/IOServer';
import type { IOServerSocket } from '../../src/net/IOServerSocket';

// 仅检查类型，不建立连接、不实际注册；通过 pnpm test:types 验证。
function checkMessageHandlers(server: IOServer, client: IOClient) {
    client.sendMsg(1);
    client.sendMsg(1, 'hello', 42, { enabled: true }, ['nested']);
    const packet: [number, ...any[]] = [1, 'hello'];
    client.sendMsg(...packet);
    // @ts-expect-error 必须提供数字消息 ID。
    client.sendMsg();
    // @ts-expect-error 第一个参数不能是字符串。
    client.sendMsg('1', 'hello');
    // @ts-expect-error sendMsg 接收展开参数，数组形式仍使用 send。
    client.sendMsg([1, 'hello']);

    // 普通消息允许同步无返回值、提前 return，以及异步无返回值。
    server.onMessage(1, (socket: IOServerSocket, name: string) => { console.log(name); });
    server.onMessage(2, () => { return; });
    server.onMessage(3, async () => { await Promise.resolve(); });
    client.onMessage(1, (name: string) => { console.log(name); });
    client.onMessage(2, async () => { await Promise.resolve(); });

    // 服务端采用标准 void 回调类型，允许传入有返回值的函数，但返回值被忽略。
    server.onMessage(4, () => 1);
    server.onMessage(5, () => [0, 'result']);
    server.onMessage(6, async () => 1);
    server.onCallback(8, () => [0, 'result']);
    // @ts-expect-error RPC 处理函数必须返回错误码或结果元组。
    server.onCallback(9, () => 'result');
    // @ts-expect-error 服务端回调的第一个参数必须是 socket。
    server.onMessage(10, (socket: string) => {});
    // @ts-expect-error 客户端普通消息同样不能返回字符串。
    client.onMessage(3, () => 'result');
    // @ts-expect-error 客户端异步普通消息同样不能返回结果。
    client.onMessage(4, async () => [0, 'result']);

    // 已声明的函数也检查返回类型，不局限于直接传入的箭头函数。
    const withResult = (name: string) => name.length;
    const withoutResult = (name: string): void => { console.log(name); };
    client.onMessage(5, withoutResult);
    // @ts-expect-error 已声明的函数返回数字，也应拒绝。
    client.onMessage(6, withResult);

    // 服务端 void 回调也允许部分分支带返回值。
    server.onMessage(7, (socket: IOServerSocket, enabled: boolean) => {
        if (enabled) return 1;
    });
}
