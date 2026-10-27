# LiteSocket 测试

在 LiteSocket 根目录安装依赖并运行：

```sh
pnpm install
pnpm test
```

`pnpm test` 使用本项目的 TypeScript 编译器检查源码和测试类型，再通过 Node.js 内置测试运行器执行 `net/`、`net2/`、`other/` 中的测试。公共辅助文件位于 `test/` 根目录。

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

`test/net2/test_lite_errorenum.ts` 通过实际错误处理入口覆盖 `ErrorEnum` 的所有运行期错误码，并检查 `Max` 自定义错误码边界；已纳入 `pnpm test`。单独运行：

```sh
pnpm test:build
node --test .test-build/test/net2/test_lite_errorenum.js
```

测试日志器实现本库的 `LiteLogger` 接口；测试使用本机回环地址和系统分配的临时端口。完整测试按文件串行运行，减少计时测试受到并发负载的影响。
