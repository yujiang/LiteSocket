// 仅使用 DOM 类型，验证客户端声明不要求 Node.js 的类型包。
import { IOClient, LiteClient, ErrorEnum, SocketCloseCode, createSliceLogger } from '../../lib/client/index.js';

const client = new LiteClient('browser', createSliceLogger(), {
    createSocket: url => new WebSocket(url),
});
client.onEvent('connect', () => client.emit('hello', 'browser'));
client.close(SocketCloseCode.normal);
const rpc = new IOClient('rpc', console, { checktimeout: true });
const result: Promise<ErrorEnum> = rpc.asende([1]);
void result;
