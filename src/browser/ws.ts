// 只使用浏览器原生 WebSocket；不向浏览器打包 Node.js 的 ws 实现。
export const WebSocket = globalThis.WebSocket;
export type WebSocket = globalThis.WebSocket & { terminate?: () => void };
