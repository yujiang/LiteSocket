// 仅使用 DOM 类型，验证客户端声明不要求 Node.js 的类型包。
import { IOClient, LiteClient, ErrorEnum, SocketCloseCode, createSliceLogger } from '../../lib/client/index.js';

const client = new LiteClient('browser', createSliceLogger(), {
    createSocket: url => new WebSocket(url),
});
client.onEvent('connect', () => client.emit('hello', 'browser'));
client.close(SocketCloseCode.normal);
const sent: boolean = client.emitMsg(950003, 'payload');
void sent;
const rpc = new IOClient('rpc', console, { checktimeout: true });
rpc.sendMsg(1, 'browser', { enabled: true });
// @ts-expect-error 打包后的声明仍要求数字消息 ID。
rpc.sendMsg('1', 'browser');
// @ts-expect-error 打包后的声明仍要求至少一个参数。
rpc.sendMsg();
const result: Promise<ErrorEnum> = rpc.asende([1]);
void result;
