# LiteSocket 架构与维护说明

## 定位与分层

LiteSocket 是 TypeScript WebSocket 通信库，主要服务于游戏客户端与 Node.js 服务端，提供连接管理、消息分发、双向 RPC 和进程内房间广播。使用自己的 JSON 协议，不兼容 Socket.IO / Engine.IO。

| 层次 | 核心模块 | 职责 |
| --- | --- | --- |
| 通信基础 | LiteSocket | JSON 编解码、报文校验、发送限制、应用层心跳 |
| 连接管理 | LiteClient / LiteServer / LiteServerClient | 连接生命周期、重连、WSS、服务端限速 |
| 业务接口 | IOClient / IOServer / IOServerSocket | 消息 ID 分发、双向 RPC、错误码 |
| 请求管理 | SessionCallback / ClientSession / ServerSession | 请求响应匹配、超时、断线结算 |
| 房间 | LiteRoom / RoomManager | 加入、退出、广播、空房间清理 |
| 游戏示例 | src/game | Client → Gate → Game 路由，不从正式库导出 |

业务开发优先使用 IOClient / IOServer；需要自行组织字符串事件时使用底层 LiteClient / LiteServer。

## 线上协议与调用流程

外层封包为 `{ e, d }`。`e` 是类别，`d` 是数据：

- `system`：连接 ID 及收发上限；客户端收到合法 system 后 connectPromise 才成功。
- `ping` / `pong`：应用层心跳。
- `mod`：普通消息；`bc`：广播。
- `cb`：RPC 请求；`cb2`：RPC 响应。

业务数组第一项是消息 ID。IOClient 普通发送路径追加尾部 0，RPC 追加请求 session。

RPC 流程：`IOClient.asend([id, ...args], timeoutms)` → 保存 session 对应的 Promise resolver → 发送 `{ e: 'cb', d: [id, ...args, session] }` → 服务端按消息 ID 执行 onCallback → 返回 `{ e: 'cb2', d: [session, [errorCode, ...result]] }` → 客户端按 session 完成 Promise。

session 是请求关联编号，不是用户登录会话；支持并发请求及乱序响应。服务端也能向客户端发起 RPC。成功码 ErrorEnum.ErrorOk 为 0。

## 行为约定

- 生命周期事件支持多个监听器；同一业务消息仅保留一个处理函数，重复注册会替换并告警。
- 连接工厂通过 `LiteServer.listenPromise(port, clientFactory)` 在启动监听时传入，默认 LiteServerClient；不提供监听后设置工厂的接口。IO 层在调用底层监听之前绑定生命周期处理器并设置当前 io，确保首次连接即可创建 Session、处理 RPC 和访问连接索引。
- 自动重连默认关闭；启用后采用带随机抖动的指数退避。重连保留客户端消息处理函数，不恢复登录、房间、服务端业务状态，也不自动重发请求。
- 房间及连接均保存在当前进程；广播只序列化一次，再遍历成员发送。
- Node.js 完整库使用 ws，输出 CommonJS 及声明；浏览器适配原生 WebSocket，输出 ESM、全局脚本及不依赖 Node.js 类型的声明。
- 认证、业务参数校验、消息可靠投递、跨进程房间及业务状态恢复由应用层负责。

## 接入注意事项与维护方向

1. RPC 自动超时检查默认关闭。客户端与服务端通过 param.checktimeout 开启；checkIntervalMs 默认 1000ms。请求 timeout 为 0 时使用 Session.timeoutMax，当前默认 100000ms。超时由轮询结算，不保证精确到指定毫秒。
2. SessionCallback.sendSession 直接修改传入数组，追加 session 或 0；接收分发也通过 shift 修改数组。每次发送应创建新数组，或使用 sendMsg / asendCallback 等变参接口。
3. 收发大小限制当前按 JavaScript 字符串长度计算，不是 UTF-8 字节数。接收校验在完整消息转换为字符串后执行；服务端没有将 maxRecvLen 传给 ws.maxPayload，不能视为传输层内存上限。
4. 发送路径没有基于 bufferedAmount 的积压控制；高频广播和慢客户端场景需要进一步评估。
5. IOServer.listen 遇到 EADDRINUSE 每秒持续重试，没有次数上限或取消参数。
6. 文档必须与源码同步：线上字段为 e/d；客户端 RPC 使用 asendCallback 或 asend；当前直接运行时依赖为 ws 和 tslib，不包含 chalk。

## 文档与验证

重要公共类型、配置字段和函数使用英文 JSDoc，注明单位、默认值、返回值、生命周期和副作用；保留在生成的 .d.ts 中。不得仅为补注释改变运行行为或公共签名。

验证命令：`pnpm test`、`pnpm test:lib`、`pnpm example:build`。pnpm 不可用时可直接使用本地 TypeScript 编译器及 Node.js 测试运行器。test:lib 包含浏览器声明及隔离运行测试，需要 Node.js 22+，不代替真实浏览器集成或负载测试。

2026-10-30 首次分析时，重新编译后的源码测试 348 项通过，0 失败。此记录是当时的验证结果，不代表后续修改已验证。
