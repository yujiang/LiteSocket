## 目的
1. socket.io 比较老旧和笨重了, 分层太多并且适配麻烦
2. client connect server 总是很麻烦
现在不必去注册 'connect', 'connect_fail', 'error'
支持 await client.connectPromise() 这样比较直白
let ok = await client.connectPromise()
if (ok) {
    client.on("disconnect", on_disconenct)
    ...
    this.client = client
}
3. 在消息send,recv超过大小后, emit "exception" 而不是吞掉错误.

## 与socket.io相同点
1. 'connect','connect_fail' 等消息保证只有一次
2. 支持 room 用于广播消息
3. 支持 ping - pong 的心跳, 及时检测断线

## api的差异
1. event 与 msg 分开 -- 会清晰一点
socket.on 注册 msg的解析
socket.onEvent 注册 socket本身事件('connect','disconnect')的解析
2. 并没有用node:Event, 而是用callback函数
event, msg 事件只有唯一的响应. (主要我应用中感觉一个就足够了)

## TODO
1. 日志级别接受定制(比如connect->warn, close->info...)




## 服务端监听

构造和监听分为两步：`new LiteServer(name, opts)` 只保存配置，可以先注册事件和消息回调；显式调用 `await server.listenPromise(port)` 才创建监听器，返回 `[true]` 或 `[false, error]`。

```ts
const server = new LiteServer(name, opts);
server.onClient('client-connect', client => {
    console.log('connected', client.id);
});
server.onMessage('hello', (client, data) => {
    client.emit('hello', data);
});
const [ok, error] = await server.listenPromise(port);
```
错误对象保留 `code`，如端口占用的 `EADDRINUSE`。监听失败自动清理实例，只有监听成功才启动心跳；端口为 `0` 时，成功后 `server.port` 更新为实际端口。
每个 `LiteServer` 实例只调用一次 `listenPromise`，按“创建、注册回调、等待监听完成、运行、关闭”的生命周期使用；不提供重复监听、切换端口或启动中取消的处理。需要再次启动时创建新实例。

`server.kickoff(id, reason = 'kickoff')` 按连接 ID 断开指定客户端，使用 `SocketCloseCode.disconnect` 并传递关闭原因；未知 ID 不做处理。断线事件、房间清理和业务 RPC 结算走正常断开流程，不影响其他连接。此操作不是封禁，开启自动重连的客户端仍可能重新连接。

## WSS / TLS

在 `LiteOptionsInput` 中同时传入 PEM 私钥和证书文件路径，服务端会创建 HTTPS 监听器并提供 WSS：

```ts
const server = new LiteServer('secure-server', console, {
    keyfile: './certs/server.key',
    certfile: './certs/fullchain.pem',
});
const [ok, error] = await server.listenPromise(8443);
if (!ok) throw error;
```

`IOServer` 通过 `listen(name, port, opts)` 的第三个参数传入同样的配置。均未配置时使用普通 WS；只配置其中一个或传入空路径时返回 `ERR_TLS_CONFIG`，不会回退到 WS。文件在监听时读取，相对路径以进程工作目录为基准。证书读取、解析失败或端口占用均返回 `[false, error]`；监听失败不会启动心跳。

使用与证书匹配的域名连接 `wss://example.com:8443`。`getWsUrl(host, port, true)` 返回 WSS 地址，省略第三个参数仍返回 WS 地址。客户端继续验证证书和主机名；Node 客户端测试自签名证书时，可通过现有 `createSocket` 配置信任的 CA：

```ts
const client = new LiteClient('secure-client', console, {
    createSocket: url => new WebSocket(url, { ca: readFileSync('./certs/test-ca.pem') }),
});
await client.connectPromise('wss://localhost:8443');
```

上例的 `WebSocket` 来自 `ws`，`readFileSync` 来自 `node:fs`。浏览器客户端使用其自身的证书信任设置。`server.close()` 同时关闭 HTTPS 监听器、WebSocket 连接和未完成 TLS 握手的连接，释放端口。

测试文件为 `test/net/test_lite_wss.ts`，专用测试证书位于 `test/fixtures/tls/`，运行测试不需要 OpenSSL。

## 服务端日志

`new LiteServer(name, { logger })` 可以传入自定义 logger，默认使用 `console`。`LiteLogger` 只要求 `info`、`warn`、`error` 三个方法，不依赖 Winston；可直接传入现有 Winston logger。
`LiteServer` 自身的连接、断线、广播异常、重复注册提醒和监听器错误均通过该 logger 输出。每次 `kickoff` 都会记录一条 warn，包含服务器标识、连接 ID 和踢人原因；即使 ID 不存在也保留调用记录。
`IOServer` 会自动把已有的业务 logger 传给 `LiteServer`，不用再单独配置。此配置仅作用于 `LiteServer`，客户端和其他模块的日志策略保持不变。

## 客户端消息限速

`LiteOptionsInput.messageRateLimit` 配置每条连接的入站消息令牌桶，不配置则不限速：

```ts
const server = new LiteServer('server', {
    messageRateLimit: { perSecond: 1, burst: 60 },
});
// IOServer 则通过 listen(name, port, opts) 的第三个参数传入相同配置。
```

`perSecond` 是每秒补充的额度，允许正的小数；`burst` 是正整数，表示最多积攒多少额度。新连接初始额度为 `burst`，每条业务消息消耗一个额度。空闲或网络阻塞期间会积攒额度，恢复后允许一次集中到达，但不会超过桶容量。
使用单调时钟，在消息到达时计算补充量，不创建额外定时器。ping/pong 不计数；其他合法消息在派发到单连接或全局处理器前统一计数，包括 RPC 请求和响应。
额度不足时不派发该消息，调用 `kickoff(id, 'message rate limit')`，断线及待处理 RPC 走原有清理流程。
该限制是“平均速率 + 突发容量”，不是严格的“任意一分钟最多 60 条”。它按连接计数，不按用户或 IP，重新连接会获得新的额度。

`IOServerBase.listen(name, port, opts)` 返回相同格式的 Promise，端口占用时每秒重试，其他错误直接返回。
成功后通过 `io` 访问监听实例，`close()` 关闭已经启动的服务器。不支持启动中取消监听或取消端口占用重试，也不支持并发调用 `listen()`；按启动流程等待 `await listen()` 完成即可。已启动后再次 `listen()` 会先关闭原服务器。

## IOServer 业务封装

`IOServer` 使用 `LiteServer`，保留已有的 `TypeHandle`、`MsgHandle`、`MsgHandleCB` 和 `SockWrap` 消息及请求回调协议。
构造 `new IOServer(name, logger?)` 后即可向 `modhandle`、`cbhandle` 注册业务处理，再调用 `await server.listen(name, port, opts)`。
底层连接、消息和日志回调在监听前绑定；重试或重新监听不会重建业务处理器、丢失已注册消息。

业务处理器获得的 `IOServerSocket` 继承 `LiteServerClient`，直接持有 WebSocket，只增加 `cb`、`logger`、`$socketClientId` 等业务能力，不再包装另一层连接。
连接只保存在 `server.io.clients` 中，`server.findById(id)` 返回业务连接，与 `server.io.findById(id)` 是同一个对象；不再提供独立的 `server.sockets` 集合和 `socket.client` 包装引用。
`LiteServerClient.on(event, handler)` 注册单连接消息处理器；收到消息时优先调用单连接处理器，未注册时回退到 `LiteServer.onMessage`，不会重复派发。`TypeHandle.bindSocket` 直接绑定真实连接，不再需要 `dispatch` 转发循环。
`MSG_SYSTEM_CONNECT`、`MSG_SYSTEM_DISCONNECT` 在注册了对应处理器时分别派发一次；断开和服务器关闭都会清理会话，并以 `Callback_disconnect` 完成等待中的服务端请求。

`server.bc(room, data)` 对应 LiteServer 的房间广播，房间不存在时不发送。
客户端错误、协议异常和广播异常写入传入的 logger；`getIp` 使用 WebSocket 握手时记录的远端地址，并保留 IPv6 地址格式。
内置 `MSG_SYSTEM_QUERYHTTPSERVER` 查询 `name` 返回 `[ErrorOk, name]`，未知键返回 `[Error_invalidParam, description]`，遵循现有回调结果格式。

`LiteServer` 构造函数的第三个可选参数是连接工厂 `(ws, server, id, remoteAddress) => LiteServerClient`，默认创建基础连接。`IOServer` 通过工厂直接创建 `IOServerSocket`；其他业务也可以返回自己的连接子类。

## IOClient 业务封装

`IOClient.onMessage` 和 `IOServer.onMessage` 检查处理函数实际推断的返回类型：允许 `void`、`Promise<void>`，拒绝返回业务数据的同步或异步函数；需要返回结果时使用 `onCallback`。不要提前把有返回值的函数标注成 `() => void`，因为 TypeScript 会丢失原始返回类型，注册接口无法恢复这部分信息。

`onMessage` 和 `IOClient.onBroadcast` 直接注册普通业务处理函数，不额外吞掉异步 rejection；应用可通过全局 `unhandledRejection` 统一记录和上报。同步异常以及 RPC 业务处理函数的异常和返回值校验仍沿用现有消息框架的处理策略。

`new IOClient(name, param, opts?, logger?)` 直接组合 `LiteClient` 和 `NetCallback`，不需要额外的回调适配层。`LiteClient.connected` getter 与 `isConnected()` 返回相同的协议就绪状态。
可在连接前注册 `modHandle`、`bcHandle`、`cbHandle`；`await client.connectServer(url, disconnect)` 返回是否连接成功。
发送前会使用 Lite 的 `isConnected()` 检查状态，未连接时 `send` 不发送，`asend` / `asende` 返回 `Net_notconnect`。

再次调用 `connectServer` 会取消旧连接尝试并结算旧请求，旧尝试不能覆盖新连接。连接失败不会通知 `disconnect`。
已连接后的断线先清理旧状态并以 `Callback_disconnect` 结算所有待响应请求，再调用 `disconnect(reason, err)`，回调中可立即重连。
`destroy(why)` 静默关闭，也能取消正在进行的连接；不会通知 `disconnect`，但仍结算待响应请求。
直接调用底层 `socket.close()` 则保留断线通知。启用 `param.checktimeout` 时，`IOClient` 启动定时器调用 `NetCallback.onCheck()`，由 `ClientParam.checkIntervalMs` 配置检查间隔（毫秒），默认 `1000`；非有限数或非正数也回退到默认值。该间隔不是单个请求的超时，请求超时仍通过 `asend(data, timeoutms)` 指定，在下一次轮询时结算。关闭、替换连接或不启用重连的连接失败时释放定时器，自动重连期间复用同一个定时器，不向旧版 Timex 注册永久监听。

传入 `opts.autoReconnect: true` 时，首次失败仍返回 `false`，但保留底层客户端继续重试；已连接后断线仍结算旧请求、通知 `disconnect`，不销毁消息处理器和底层实例，以便自动恢复。不会自动重发旧请求。

## 连接就绪

`await client.connectPromise(url)` 返回成功时，WebSocket 已打开且客户端已收到 `system`，可立即读取 `getServerId()`、`getSys()` 和收发上限并发送业务消息。
`connect` 事件也在此时触发。等待系统配置期间，`isConnecting()` 为 `true`，`isConnected()` 为 `false`；重复连接同一地址共享原 Promise。
连接超时覆盖握手和等待系统配置的全过程；初始化前关闭连接触发 `connect_fail`，不会触发 `disconnect`。

`close()` 会通知 `disconnect`（已连接时）或 `connect_fail`（初始化完成前），并保留回调供重新连接使用。
`destroy()` 静默销毁连接，立即清理心跳、连接超时和所有回调，不再通知 `disconnect`、`connect_fail`、`close` 等事件；等待中的 `connectPromise` 返回 `[false, 'destroyed']`。

## 客户端自动重连

自动重连已内置到 `LiteClient`，无需另外创建重连包装器：

```ts
const client = new LiteClient('client', {
    autoReconnect: true,
    backoff: { baseMs: 800, maxMs: 15000, factor: 2, jitter: 0.25, maxRetries: Infinity },
});
client.onEvent('reconnect', retry => console.log('安排重试', retry));
client.onEvent('connect', count => console.log('连接成功', count));
const [connected, reason] = await client.connectPromise(url);
```

`autoReconnect` 默认 `false`，保留单次连接行为。开启后，初次失败以及连接成功后的网络异常、远端关闭、心跳超时都会自动重连；消息和事件处理器保留。
`connect` 和 `connectPromise` 都可以启动重连，Promise 只返回本次尝试的结果，不等待后台重试最终成功。同一地址正在连接时仍共享一个 Promise。

`backoff` 为可选退避配置，上述值即默认值；`maxRetries` 不含首次尝试，`0` 表示不重试。每次连接成功清零重试计数，`getRetryCount()` 返回当前连续重试次数。
新增事件 `reconnect`（退避等待前，参数为重试编号）、`reconnect_fail`（一次重试失败，参数为重试编号）、`retries_exhausted`（连续重试耗尽）。原有 `connect_fail` 每次尝试最多一次，`disconnect` 只针对已经成功建立的连接。
开启自动重连时，`connect` 参数为累计连接成功次数；关闭自动重连时保持原有事件参数。

主动 `close()` / `disconnect()` 取消后台重试，但仍通知本次断线；之后可以手动再次连接。`destroy()` 也取消重试，并静默清除所有处理器。切换 URL 会取消旧重试循环，回调中关闭、销毁或改连都不会留下旧的后台循环。

## 广播异常

全服广播和房间广播发生超限或序列化失败时，通过服务端自身的回调通知一次，不按接收人数重复通知，也不伪装成某个客户端的异常：

```ts
server.onEvent('exception', (reason, details) => {
    console.error(reason, details);
});
```

`reason` 为 `msgSendMax` 或 `msgJsonStringError`。`details` 包含 `eventName`、`limit`，房间广播还包含 `room`；超限时包含 `length`，序列化失败时包含原始 `error`。
客户端连接上的单发及接收异常仍通过客户端 `onEvent('exception', ...)` 或服务端 `onClient('exception', ...)` 通知。

单发发送失败的诊断详情包含 `eventName`、原始 `data`，序列化失败或底层发送抛错时还包含 `error`。原因分别为 `msgSendMax`、`msgJsonStringError`、`msgSendError`；原始数据可能包含循环引用，记录详情时不要再次直接 JSON 序列化它。
`IOClient` 和 `IOServerSocket` 会根据发送详情匹配对应的待处理请求，并立即以 `[ErrorEnum.ErrorError, reason]` 结束请求；`asende` 只返回该错误码。不会 reset 其他待处理请求，也不依赖超时轮询。此处针对请求发送失败，不自动重发请求。

JSON 解析成功后还会检查消息信封和 `system/ping/pong` 的数据结构；非法结构通知一次 `exception(msgInvalidPacket)` 后丢弃，不会触发业务消息处理或把客户端标记为连接成功，之后的合法消息仍可正常处理。

## 消息长度限制

`LiteOptionsInput` 分别配置当前服务端的 `maxSendLen` 和 `maxRecvLen`，默认均为 `1024 * 1024`。
例如 `{ maxSendLen: 1024 * 1024, maxRecvLen: 64 * 1024 }` 允许服务端下发较大的数据，限制客户端上行数据。

服务端通过 `system` 消息下发客户端视角的限制：客户端 `maxSendLen` 等于服务端 `maxRecvLen`，客户端 `maxRecvLen` 等于服务端 `maxSendLen`。
客户端收到系统配置前，两个方向均使用默认值；重连时旧配置会清空。

单发、全服广播和房间广播都检查发送上限，接收方独立检查接收上限；`wsSend` 只绕过发送检查。
边界规则统一为 JSON 字符串的 `length >= 上限` 时拒绝，当前单位是 JavaScript 字符串长度，不是 UTF-8 字节数。

原来的 `maxLen`、`maxLen()` 和 `getMaxLen()` 已替换为对应的收发字段和方法，`system` 消息结构也同步更新，通信双方需要一起升级。

| 文件 | 功能 |
|------|------|
| LiteNet.ts | 公共类型和协议常量 |
| LiteSocket.ts | LiteClient 和 LiteServerClient 的基类 |
| LiteServer.ts | 服务器监听和连接管理 |
| LiteServerClient.ts | 服务端持有的客户端连接 |
| LiteRoom.ts | 房间和广播 |
| LiteClient.ts | 客户端连接、心跳和可选自动重连 |

