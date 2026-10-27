import type { LiteLogger } from '../src/public/log';

// 使用本库的日志接口，测试无需依赖业务项目的 Winston 配置。
export class Logger implements LiteLogger {
    info(..._args: unknown[]): void {}
    warn(..._args: unknown[]): void {}
    error(..._args: unknown[]): void {}
    debug(..._args: unknown[]): void {}
    log(..._args: unknown[]): void {}
    close(): void {}
}

export function createLogger(_options: { silent?: boolean } = {}): Logger {
    return new Logger();
}
