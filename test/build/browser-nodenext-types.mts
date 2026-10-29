// 消费者使用 NodeNext 时，浏览器入口的声明文件也必须能解析。
import { IOClient, LiteClient, ErrorEnum, createSliceLogger } from '../../lib/client/index.js';

const client = new LiteClient('browser-nodenext', createSliceLogger());
client.cancelReconnect();
const rpc = new IOClient('browser-rpc', console, { checktimeout: true });
rpc.onCallback(1, (value: number) => [ErrorEnum.ErrorOk, value]);
rpc.onBroadcast(2, (value: string) => { console.log(value); });
const result: Promise<ErrorEnum> = rpc.asendeMsg(1, 'request');
void result;
