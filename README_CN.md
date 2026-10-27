# LiteSocket

**[English](README.md) | 简体中文**

同一套源码生成两份库：完整 Node.js 库，以及只使用浏览器原生 WebSocket 的客户端库。

## 设计启发

LiteSocket 的底层通信层 `LiteServer` / `LiteClient` 受到 [Socket.IO](https://socket.io/) 的启发，提供连接生命周期、事件消息、心跳和房间广播。在此基础上，`IOServer` / `IOClient` 进一步简化业务接口，并扩展消息分发、RPC、错误码和诊断能力，主要用于游戏客户端与 Node.js 服务端之间的交互。

**LiteSocket 使用自己的 JSON 消息协议，不兼容 Socket.IO / Engine.IO 协议。** 两端需要使用 LiteSocket，或者按 LiteSocket 的协议实现对应逻辑；不能直接混用 Socket.IO 的客户端和服务端。

## 两层 API

| 层次 | 服务端 / 客户端 | 职责 |
| --- | --- | --- |
| 底层通信层 | `LiteServer` / `LiteClient` | WebSocket / WSS 连接、字符串事件消息、生命周期事件、心跳、重连、大小限制及服务端房间广播 |
| 业务接口层（推荐） | `IOServer` / `IOClient` | 在底层连接之上，以消息 ID 组织业务处理，简化注册和收发接口，并增加 session RPC、错误码和超时处理 |

业务开发优先使用 **`IOServer` / `IOClient`**：用 `onMessage()` 和 `send()` 处理普通消息，用 `onCallback()` 注册 RPC，用 `asend()` 获取错误码与结果，或用 `asende()` 只获取错误码。需要自行组织字符串事件和协议时，再直接使用 `LiteServer` / `LiteClient`。

连接与心跳由底层负责，IO 层复用这些能力；RPC 的 session、返回值和超时由 IO 层组织。下面与 Socket.IO 的比较针对底层通信层，后续代码示例则使用推荐的 IO 层。

## 为什么要造轮子

这个项目的出发点，是为已经确定使用 WebSocket 的业务提供一套职责集中、便于维护和适配的通信层：

- **连接流程更直接**：通过 `await connectPromise()` 等待连接结果，收到服务端 `system` 消息、完成协议初始化后才视为连接成功。
- **区分连接事件与业务消息**：`onEvent()` 处理客户端连接生命周期，`on()` 处理业务消息；服务端使用 `onClient()` 接收连接事件。
- **让请求响应贴合业务**：在 `IOServer` / `IOClient` 层使用消息 ID、session 和错误码组织 RPC，通过 `asend()` 获取结果，通过 `asende()` 只获取错误码。
- **方便定位问题**：支持日志注入、单连接消息观察、性能统计，以及收发大小限制和异常通知。
- **控制维护范围**：浏览器直接使用原生 WebSocket，服务端使用 `ws`，集中维护当前业务需要的连接、心跳、重连和消息分发逻辑。

项目以可读性、业务适配和维护范围为主要设计目标。Socket.IO 同样提供 Promise 和超时等能力，并覆盖更丰富的传输适配与连接管理场景。

## 与 Socket.IO 的异同

这里比较 Socket.IO 与 `LiteServer` / `LiteClient`。两者都提供双向通信、连接状态通知、心跳检测和服务端房间广播；`IOServer` / `IOClient` 提供的业务 RPC 扩展在下一节说明。

| 方面 | Socket.IO | LiteServer / LiteClient |
| --- | --- | --- |
| 传输层 | 基于 Engine.IO，支持 HTTP 长轮询、WebSocket 等传输及升级机制 | 只使用 WebSocket / WSS，不提供长轮询回退 |
| 消息协议 | 使用 Socket.IO / Engine.IO 协议 | 使用 `{ eventName, data }` JSON 封包，以字符串事件名分发消息 |
| 事件注册 | 同一事件可以注册多个监听器 | 每个事件或消息只保留一个处理函数，重复注册会替换并记录提醒 |
| 连接处理 | 提供连接事件与连接管理机制 | 提供 `connectPromise()`，以收到 `system` 消息作为协议就绪条件 |
| 自动重连 | 客户端提供自动重连能力 | 默认关闭，可通过 `autoReconnect` 开启指数退避重连 |
| 房间与扩展 | 提供房间、命名空间和多实例适配器等机制 | 提供进程内的房间与广播，未实现命名空间和跨实例适配器 |
| 断线恢复 | 提供可选的连接状态恢复能力 | 重连后保留客户端消息处理函数，不自动恢复服务端业务状态或重发请求 |

底层通信能力的比较以 [Socket.IO 官方功能说明](https://socket.io/docs/v4/how-it-works/) 和 [客户端 API](https://socket.io/docs/v4/client-api/) 为参考。LiteSocket 的连接重试不等同于消息补发：消息持久化、业务重试及幂等处理由应用层负责。

## IOServer / IOClient 的简化与扩展

`IOServer` / `IOClient` 在 `LiteServer` / `LiteClient` 上提供面向业务的接口：

- **消息 ID 分发**：用数字消息 ID 配合 `onMessage()` 注册处理函数，使用 `send([消息ID, ...参数])` 发送普通消息。
- **RPC 请求响应**：服务端使用 `onCallback()`，处理函数返回错误码或 `[错误码, ...结果]`；客户端通过 `asend()` 等待对应结果，session 由框架匹配。
- **统一错误处理**：使用 `ErrorEnum` 表达未连接、处理函数不存在、返回值非法、超时、断线和发送失败等情况；`asende()` 适合只关心错误码的调用。
- **减少业务接线**：`IOServer` 管理业务消息处理器和 `IOServerSocket`，`IOClient.connectServer()` 负责建立连接及绑定消息分发，复用底层日志、观察与连接管理能力。

RPC 超时检查需要在 `IOClient` 中开启 `checktimeout`。`checkIntervalMs` 控制检查间隔；下面的客户端示例已开启检查。

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

TypeScript，使用推荐的业务接口层：

```ts
import { IOServer, ErrorEnum } from '@mosnpm/litesocket';
import type { IOServerSocket } from '@mosnpm/litesocket';

enum Message {
    Hello = 960001,
    HelloReply,
    Add,
}

async function main(): Promise<void> {
    const server = new IOServer('server', console);
    server.onMessage(Message.Hello, (socket: IOServerSocket, name: string) => {
        socket.send(Message.HelloReply, `你好, ${name}!`);
    });
    server.onCallback(Message.Add, (_socket: IOServerSocket, a: number, b: number) => {
        return [ErrorEnum.ErrorOk, a + b];
    });
    const [ok, error] = await server.listen('server', 8080);
    if (!ok) throw error;
}

void main().catch(console.error);
```

完整库从 `@mosnpm/litesocket` 导出 `IOServer`、`IOClient`，也保留底层 `LiteServer` / `LiteClient`。Node.js TypeScript 项目可将 `module`、`moduleResolution` 配置为 `Node16`。

## 浏览器客户端

TypeScript 项目中，通过客户端入口导入 `IOClient`，由打包工具处理包名导入。消息 ID 与上面的 `IOServer` 示例保持一致：

```ts
import { IOClient, ErrorEnum } from '@mosnpm/litesocket/client';

enum Message {
    Hello = 960001,
    HelloReply,
    Add,
}

const client = new IOClient('browser', console, {
    checktimeout: true,
    checkIntervalMs: 50,
});
client.onMessage(Message.HelloReply, (message: string) => {
    console.log(message);
});

async function main(): Promise<void> {
    const connected = await client.connectServer('ws://localhost:8080', reason => {
        console.warn('连接断开：', reason);
    });
    if (!connected) throw new Error('连接失败');
    client.send([Message.Hello, '浏览器']);
    const [code, sum] = await client.asend([Message.Add, 3, 5], 3000);
    if (code !== ErrorEnum.ErrorOk) throw new Error(`RPC 失败： ${code}`);
    console.log('3 + 5 =', sum);
}

void main().catch(console.error);
```

浏览器 TypeScript 配置需要包含 `DOM` 类型，并可使用 `moduleResolution: "bundler"` 解析 `/client` 子入口。Node.js 客户端使用同样的 `IOClient` 接口，从 `@mosnpm/litesocket` 导入即可。

不经过打包工具时，可以从静态服务器直接加载构建后的 ES Module 文件：

```html
<script type="module">
  import { IOClient, ErrorEnum } from './lib/client/index.js';
  ...
</script>
```

也可以直接引入普通脚本：

```html
<script src="./lib/client/litesocket.global.js"></script>
<script>
  const { IOClient, ErrorEnum } = LiteSocket;
  ...
</script>
```

浏览器构建默认使用原生 `WebSocket`，无需传入 `createSocket`。IO 层复用底层连接与重连能力，调用 `client.destroy("离开页面")` 可关闭连接并清理定时器。WSS 使用浏览器自身的证书校验，连接地址改为 `wss://`。

## 验证

两份构建产物的配套例子见 [`example/lib/`](example/lib/README.md)。运行 `pnpm example:lib` 即可启动完整库服务端，并在浏览器演示客户端库。

```sh
pnpm test       # 源码的连接、协议、RPC、事件、TLS 等测试
pnpm test:lib   # 构建产物、浏览器声明和客户端运行时测试
```

`test:lib` 需要 Node.js 22+ 的原生 WebSocket。测试在隔离环境中移除 `require`、`process` 和 `Buffer`，提供浏览器风格的数字定时器，使用原生 WebSocket 与实际服务端通信，验证消息、二进制 JSON、RPC、超时和重连。此验证不启动浏览器 UI。
