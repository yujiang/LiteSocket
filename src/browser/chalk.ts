// 浏览器控制台不使用终端 ANSI 转义序列。
const plain = (value: unknown): string => String(value);
export const red = plain;
export const yellow = plain;
export const green = plain;
