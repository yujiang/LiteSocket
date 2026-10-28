// LiteNet.ts
// 提供公共的结构

import * as chalk from 'chalk';

// 必须return void
// export type LiteMessageHandler<Handler extends (...args: any[]) => unknown> = Handler &
// 	([Awaited<ReturnType<Handler>>] extends [void] ? unknown : never);

export interface SocketSysMessage {
	id: number;
	maxSendLen: number;
	maxRecvLen: number;
}

export interface MessageRateLimit {
	perSecond: number;
	burst: number;
}

export interface LiteOptionsInput {
	/** 同时配置 keyfile 和 certfile 时启用 WSS；路径相对于进程工作目录。 */
	keyfile?: string;
	certfile?: string;
	heartbeatInterval?: number;
	heartbeatTimeout?: number;
	maxSendLen?: number;
	maxRecvLen?: number;
	messageRateLimit?: MessageRateLimit;
}

export interface LiteOptions {
	keyfile?: string;
	certfile?: string;
	heartbeatInterval: number;
	heartbeatTimeout: number;
	maxSendLen: number;
	maxRecvLen: number;
	messageRateLimit?: MessageRateLimit;
}

export interface BroadcastExceptionDetails {
	eventName: string;
	length?: number;
	limit: number;
	room?: string;
	error?: unknown;
}

export interface SendExceptionDetails {
	eventName: string;
	data: any;
	error?: unknown;
}

export function logHeadEx(classname: string, name: string|number, func: string, logtype?: string) {
	let prefix = '';
	if (logtype === 'error') {
		prefix = chalk.red('[ERROR]');
	} else if (logtype === 'warn') {
		prefix = chalk.yellow('[WARN]');
	} else {
		return `[${classname}] ${name} ${func}`;
	}
	return `${prefix} [${classname}] ${name} ${func}`;
}


export const msgSendMax = 'send >= maxSendLen'
export const msgJsonParseError = 'JSON.parse error'
export const msgRecvMax = 'recv >= maxRecvLen'
export const msgJsonStringError = 'JSON.stringify error'
export const msgInvalidPacket = 'invalid packet'
export const msgSendError = 'WebSocket.send error'

export type DisconnectReason = 'close' | 'error' | 'pong-timeout';
export type ConnectFailedReason = 'close' | 'error' | 'timeout';

export type socketClientEvent =
	| 'connect'
	| 'disconnect'
	| 'connect_fail'
	| 'reconnect'
	| 'reconnect_fail'
	| 'retries_exhausted'
	| 'pong-timeout'
	| 'close'
	| 'error'
	| 'exception';

export interface CommonSocket {
  emit(event: string, data?: any): void;
  stopPong(stop: boolean): void; // 有的实现可能没有，设为可选
  wsSend(s: string): void;
  isConnected(): boolean;
  getArgDelay(): number;
  close(code: SocketCloseCode, reason?: string): void;
  disconnect(code: SocketCloseCode, reason: string): void;
}

// common types
export interface CommonClient extends CommonSocket {
  on(event: string, handler: (data?: any) => void): void;
  onEvent(event: string, handler: (payload?: any, err?: Error) => void): void;
  getServerId(): number;
  getSys(): any;
}


export enum SocketCloseCode {
	normal = 4000, // 正常关闭!
	heartbreak ,
	connect_timeout ,
	disconnect ,	
	stop ,	
	test ,
}

export function getWsUrl(ip: string, port:number, secure = false){
	return `${secure ? 'wss' : 'ws'}://${ip}:${port}`
}
