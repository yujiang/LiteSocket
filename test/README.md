# LiteSocket 测试

在 LiteSocket 根目录安装依赖并运行：

```sh
pnpm install
pnpm test
```

`pnpm test` 使用本项目的 TypeScript 编译器检查源码和测试类型，再通过 Node.js 内置测试运行器执行 `net/`、`net2/`、`other/`、`game/` 中的测试。公共辅助文件位于 `test/` 根目录。示例保留在 `example/`，断言、超时、清理和边界场景放在测试目录。

编译前会清理 `.test-build/`，避免移动、重命名测试后仍运行旧产物。不依赖原业务项目或全局安装的 TypeScript、ts-node、Winston。

仅检查类型（包含 `@ts-expect-error` 用例）：

```sh
pnpm test:types
```

单独运行某个测试文件：

```sh
pnpm test:build
node --test .test-build/test/net/test_lite_connect.js
```

`test/net2/test_lite_errorenum.ts` 通过实际错误处理入口覆盖 `ErrorEnum` 的所有活跃运行期错误码，并检查 `Max` 自定义错误码边界。`Callback_not_find` 对应的旧 `asendSock` 已移除，仅保留错误码编号。该测试已纳入 `pnpm test`。单独运行：

```sh
pnpm test:build
node --test .test-build/test/net2/test_lite_errorenum.js
```

测试日志器实现本库的 `LiteLogger` 接口；测试使用本机回环地址和系统分配的临时端口。完整测试按文件串行运行，减少计时测试受到并发负载的影响。

## 按改动选择检查

| 改动范围 | 对应覆盖 | 验证命令 |
| --- | --- | --- |
| JSON 协议、消息格式、发送失败 | `test_lite_protocol`、`test_lite_invalid_packets`、`test_lite_rpc_send_errors` | `pnpm test` |
| 连接、主动断线、取消重连 | `test_lite_connect`、`test_lite_reconnect`、`test_ioclient` | `pnpm test` |
| RPC、默认及显式超时、乱序响应 | `test_lite_sessions`、`test_lite_rpc_*` | `pnpm test` |
| 房间、限速、观察、WSS | `test/other/`、`test_lite_rate_limit`、`test_lite_wss` | `pnpm test` |
| Gate/Game 示例、playerid、退出和广播 | `test/game/test_*.ts` | `pnpm test:game` |
| 导出、浏览器运行、声明文件、模块解析 | `test/build/` | `pnpm test:lib` |

新增 Gate 测试以 `test_*.ts` 命名，`test:game` 会自动编译和执行。`game` 仍为示例，不从 lib 导出；构建测试会检查这一点。

协议外层使用 `{ e, d }`；普通业务消息为 `[msgid, ...args]`，RPC 请求尾部附带 session，响应为 `[session, [errorCode, ...result]]`。发送异常诊断仍使用 `eventName/data`，不能与线上的短字段混用。非法业务数组也必须被拒绝，且不影响下一条正常消息。

客户端与服务端都通过 `param.checktimeout` 选择是否自动检查 RPC 超时，默认关闭。服务端使用 `new IOServer(name, logger, { checktimeout: true, checkIntervalMs: 1000 })` 开启；第三个参数默认 `{}`，`checkIntervalMs` 默认 1000ms，无效值回退到默认值。监听成功后所有服务端 Session 共用一个定时器，关闭和重新监听会释放旧定时器。传入的 timeout 单位是毫秒，`0` 使用该 Session 的 `timeoutMax`（当前默认为 100000ms），显式非零值覆盖默认值。测试通过可控时间验证默认值与边界，不等待 100 秒。

`pnpm test:lib` 先重新构建 `lib`，再检查 Node.js、浏览器 ESM 和全局 script 版本。浏览器声明同时在 `Bundler` 和 `NodeNext` 模式下验证，且不借用 Node.js 或 ws 类型。浏览器运行测试使用 Node.js 原生 WebSocket 和隔离环境，需要 Node.js 22+；它不代替真实浏览器的证书、跨域和页面集成检查。

发布前运行：

```sh
pnpm test
pnpm test:lib
pnpm example:build
```

当前 Game 示例只覆盖连接成功后的业务流程，不承诺游戏服断线后的重新注册、玩家会话恢复或跨进程容灾。若增加这些能力，应在 `test/game/` 增加真实断线、重连及状态恢复测试。
