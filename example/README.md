# LiteSocket 示例

编译后的完整库和浏览器客户端库示例位于 [`lib/`](lib/README.md)，运行 `pnpm example:lib`，然后打开终端显示的页面地址。

在 LiteSocket 根目录运行：

```sh
pnpm install
pnpm example
```

`example_lite_msg.ts` 演示普通消息、同步 RPC、异步 RPC 和消息观察日志。服务端使用系统分配的空闲端口，示例结束后关闭客户端和服务端。

示例直接引用 `src/`，使用 `console` 实现日志接口、Node.js 的定时器实现异步等待，无需原业务项目、Winston 或 ts-node。编译产物位于 `.example-build/`。

RPC 返回业务结果时使用 `[ErrorEnum.ErrorOk, 结果]`，客户端通过 `asend` 接收错误码和结果。`asende` 只返回错误码，不能用于接收计算结果。
