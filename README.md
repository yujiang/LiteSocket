# LiteSocket

同一套源码生成两份库：完整 Node.js 库，以及只使用浏览器原生 WebSocket 的客户端库。

## 设计启发

LiteSocket 受到 [Socket.IO](https://socket.io/) 的启发，沿用了连接生命周期、事件消息、房间广播和请求响应等使用思路，在 WebSocket 上提供面向业务的通信接口，主要用于游戏客户端与 Node.js 服务端之间的交互。

**LiteSocket 使用自己的 JSON 消息协议，不兼容 Socket.IO / Engine.IO 协议。** 两端需要使用 LiteSocket，或者按 LiteSocket 的协议实现对应逻辑；不能直接混用 Socket.IO 的客户端和服务端。

## 为什么要造轮子

这个项目的出发点，是为已经确定使用 WebSocket 的业务提供一套职责集中、便于维护和适配的通信层：

- **连接流程更直接**：通过 `await connectPromise()` 等待连接结果，收到服务端 `system` 消息、完成协议初始化后才视为连接成功。
- **区分连接事件与业务消息**：`onEvent()` 处理客户端连接生命周期，`on()` 处理业务消息；服务端使用 `onClient()` 接收连接事件。
- **让请求响应贴合业务**：在 `IOServer` / `IOClient` 层使用消息 ID、session 和错误码组织 RPC，通过 `asend()` 获取结果，通过 `asende()` 只获取错误码。
- **方便定位问题**：支持日志注入、单连接消息观察、性能统计，以及收发大小限制和异常通知。
- **控制维护范围**：浏览器直接使用原生 WebSocket，服务端使用 `ws`，集中维护当前业务需要的连接、心跳、重连和消息分发逻辑。

项目以可读性、业务适配和维护范围为主要设计目标。Socket.IO 同样提供 Promise 和超时等能力，并覆盖更丰富的传输适配与连接管理场景。

## 与 Socket.IO 的异同

两者都提供双向通信、连接状态通知、心跳检测、房间广播和请求响应能力。主要区别在协议、API 组织及功能范围：

| 方面 | Socket.IO | LiteSocket |
| --- | --- | --- |
| 传输层 | 基于 Engine.IO，支持 HTTP 长轮询、WebSocket 等传输及升级机制 | 只使用 WebSocket / WSS，不提供长轮询回退 |
| 消息协议 | 使用 Socket.IO / Engine.IO 协议 | 使用 `{ eventName, data }` JSON 封包，RPC 附加消息 ID 和 session |
| 事件注册 | 同一事件可以注册多个监听器 | 每个事件或消息只保留一个处理函数，重复注册会替换并记录提醒 |
| 连接处理 | 提供连接事件与连接管理机制 | 提供 `connectPromise()`，以收到 `system` 消息作为协议就绪条件 |
| 请求响应 | 提供 acknowledgement、`emitWithAck()` 和超时机制 | 提供 `asend()` / `asende()`，以错误码及结果数组返回 RPC 结果 |
| 自动重连 | 客户端提供自动重连能力 | 默认关闭，可通过 `autoReconnect` 开启指数退避重连 |
| 房间与扩展 | 提供房间、命名空间和多实例适配器等机制 | 提供进程内的房间与广播，未实现命名空间和跨实例适配器 |
| 断线恢复 | 提供可选的连接状态恢复能力 | 重连后保留客户端消息处理函数，不自动恢复服务端业务状态或重发请求 |

这里的比较以 [Socket.IO 官方功能说明](https://socket.io/docs/v4/how-it-works/) 和 [客户端 API](https://socket.io/docs/v4/client-api/) 为参考。LiteSocket 的连接重试不等同于消息补发：消息持久化、业务重试及幂等处理由应用层负责。

## 安装

```sh
pnpm add @mosnpm/litesocket
```

Node.js 使用包根入口 `@mosnpm/litesocket`；浏览器使用 `@mosnpm/litesocket/client`。两种入口均自带 TypeScript 类型声明。

## 从源码构建

```sh
pnpm install
pnpm build
```

也可以单独执行 `pnpm build:full` 或 `pnpm build:client`。每个构建只清理自己的输出目录。

```text
lib/
├── full/                     # Node.js 完整库，CommonJS 和 .d.ts
│   ├── index.js
│   ├── index.d.ts
│   ├── net/
│   └── public/
└── client/                   # 浏览器客户端，无 Node.js 运行时依赖
    ├── index.js              # ES Module
    ├── index.d.ts            # 仅依赖浏览器 DOM 类型
    ├── litesocket.global.js  # 普通 script，全局变量 LiteSocket
    └── package.json
```

完整库包含 `LiteServer`、`IOServer`、房间管理和全部客户端 API，运行时需要本项目的 `ws`、`chalk`、`tslib` 依赖。浏览器客户端包含 `LiteClient`、`IOClient`、RPC、消息类型、错误码及日志和性能统计 API，不包含服务端实现。

## Node.js 完整库

TypeScript：

```ts
import { LiteServer } from '@mosnpm/litesocket';
import type { LiteServerClient } from '@mosnpm/litesocket';

async function main(): Promise<void> {
    const server = new LiteServer('server', console);
    server.onMessage('hello', (client: LiteServerClient, data: unknown) => {
        client.emit('reply', data);
    });
    const [ok, error] = await server.listenPromise(8080);
    if (!ok) throw error;
}

void main().catch(console.error);
```

完整库还导出 `IOServer`、`IOClient` 等 API，均从 `@mosnpm/litesocket` 导入。Node.js TypeScript 项目可使用 `module`、`moduleResolution` 为 `Node16` 的配置来解析包入口。

## 浏览器客户端

TypeScript 项目中，使用浏览器客户端入口，由打包工具处理包名导入：

```ts
import { LiteClient } from '@mosnpm/litesocket/client';
import type { LiteClientOptionsInput } from '@mosnpm/litesocket/client';

const options: LiteClientOptionsInput = { autoReconnect: true };
const client = new LiteClient('browser', console, options);
client.on('reply', (data: unknown) => console.log('reply', data));

async function main(): Promise<void> {
    const [ok, reason] = await client.connectPromise('ws://localhost:8080');
    if (!ok) throw new Error(reason);
    client.emit('hello', '你好');
}

void main().catch(console.error);
```

浏览器入口也导出 `IOClient`，用于配合 `IOServer` 的业务消息和 RPC。浏览器 TypeScript 配置需要包含 `DOM` 类型，并可使用 `moduleResolution: "bundler"` 解析 `/client` 子入口。

不经过打包工具时，可以从静态服务器直接加载构建后的 ES Module 文件：

```html
<script type="module">
  import { LiteClient } from './lib/client/index.js';

  const client = new LiteClient('browser', console);
  client.on('reply', data => console.log('reply', data));
  const [ok, error] = await client.connectPromise('ws://localhost:8080');
  if (ok) client.emit('hello', '你好');
  else console.error(error);
</script>
```

也可以直接引入普通脚本：

```html
<script src="./lib/client/litesocket.global.js"></script>
<script>
  const client = new LiteSocket.LiteClient('browser', console);
  client.connectPromise('ws://localhost:8080');
</script>
```

浏览器构建默认使用原生 `WebSocket`，无需传入 `createSocket`。`IOClient` 也可直接用于浏览器；定时器支持浏览器的数字 ID，重连退避可被 `destroy()` 取消。WSS 使用浏览器自身的证书校验，连接地址改为 `wss://`。

## 验证

两份构建产物的配套例子见 [`example/lib/`](example/lib/README.md)。运行 `pnpm example:lib` 即可启动完整库服务端，并在浏览器演示客户端库。

```sh
pnpm test       # 源码的连接、协议、RPC、事件、TLS 等测试
pnpm test:lib   # 构建产物、浏览器声明和客户端运行时测试
```

`test:lib` 需要 Node.js 22+ 的原生 WebSocket。测试在隔离环境中移除 `require`、`process` 和 `Buffer`，提供浏览器风格的数字定时器，使用原生 WebSocket 与实际服务端通信，验证消息、二进制 JSON、RPC、超时和重连。此验证不启动浏览器 UI。
