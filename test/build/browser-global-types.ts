/// <reference path="../../lib/client/index.d.ts" />

// 普通 script 用法也能通过全局 LiteSocket 命名空间获得类型。
const scriptClient = new LiteSocket.LiteClient('script', console);
scriptClient.onEvent('connect', () => scriptClient.emit('hello'));
