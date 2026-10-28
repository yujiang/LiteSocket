// liteClient.ts - 模拟 socket.io.client 用于web客户端
// 使用浏览器 WebSocket 风格的 API（Node 的 ws 做了适配）
//
// 与 socket.io.client 的一致点：
// 1. 连接失败时只触发一次 connect_fail 事件
// 2. 连接成功后断线只触发一次 disconnect 事件
// 3. 客户端和服务器支持双向 ping/pong 心跳检测
// 4. 消息收发统一使用 JSON 封包/解包
//
// 与 socket.io.client 的差异：
// 1. 将 event 和 msg 分开，回调只有一个函数（不使用 Node.js EventEmitter 模式）
// 2. 统一的日志输出格式（logHeadEx）
// 3. 支持消息大小上限：服务器会通过 system 消息通知客户端该上限，发送超过上限的消息会被拒绝
// 4. autoReconnect 默认关闭，开启后支持指数退避自动重连
// 适用场景：
// - 游戏客户端

import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import {
	CommonClient,
	ConnectFailedReason,
	DisconnectReason,
	SocketCloseCode,
	SocketSysMessage,
	socketClientEvent,
} from './LiteNet';
import { LiteLogger } from "../public/log";
import { LiteSocket, SocketReason } from './LiteSocket';
import { strict as assert } from 'node:assert';
// 外部逻辑只需要'connect''disconnect','connect_fail'
// 其他的是内部诊断用
// 确保'disconnect'只调用一次, reason包括: error,close
// 并且在系统事件之前调用
//
export type ClientEventFunc = (resaon: SocketReason, err?: any) => void;
export type AllClientEventFunc = (
	event: string,
	resaon: SocketReason, // number only for retrytimes
	err?: Error,
) => void;
export type MsgHandleFunc = (data?: any) => void;

export type BackoffOptions = {
	baseMs?: number;
	maxMs?: number;
	factor?: number;
	jitter?: number;
	maxRetries?: number;
};

export interface LiteClientOptions {
	heartbeatInterval: number;
	heartbeatTimeout: number;
	connectTimeout: number;
	autoReconnect: boolean;
	backoff: Required<BackoffOptions>;
	debug?: boolean;
	createSocket?: (url: string) => WebSocket; 
}

export interface LiteClientOptionsInput {
	heartbeatInterval?: number;
	heartbeatTimeout?: number;
	connectTimeout?: number;
	autoReconnect?: boolean;
	backoff?: BackoffOptions;
	debug?: boolean;
	createSocket?: (url: string) => WebSocket; // brower用Windows.WebSocket
}

interface ConnectAttempt {
	ws?: WebSocket;
	promise: Promise<[boolean, string]>;
	resolve: (result: [boolean, string]) => void;
	timeoutHandle: ReturnType<typeof setTimeout> | null;
	connected: boolean;
	disconnected: boolean;
	failed: boolean;
}

export class LiteClient extends LiteSocket implements CommonClient {
	private msgHandlers: Record<string, MsgHandleFunc> = {};
	url: string;
	private opts: LiteClientOptions;

	constructor(name: string, logger: LiteLogger, opts: LiteClientOptionsInput = {}) {
		super(name, logger);
		// if (name instanceof LiteClient) {
		// 	this.connectPeer(name);
		// 	return;
		// }
		this.opts = {
			heartbeatInterval: 10000,
			heartbeatTimeout: 15000,
			connectTimeout: 5000,
			autoReconnect: false,
			...opts,
			backoff: {
				baseMs: 800,
				maxMs: 15000,
				factor: 2,
				jitter: 0.25,
				maxRetries: Number.POSITIVE_INFINITY,
				...opts.backoff,
			},
		};
	}

	getOpts() {
		return this.opts;
	}

	// 仅仅适配SocketLinkManager
	// private connectPeer(client: LiteClient) {
	// 	this.name = client.name;
	// 	this.opts = client.opts;
	// 	this.msgHandlers = client.msgHandlers;
	// 	this.url = client.url;
	// 	// this.allEventFunc = client.allEventFunc;
	// }

	private attempt?: ConnectAttempt;
	private reconnectController?: AbortController;
	private retries = 0;
	private connectedTimes = 0;

	getRetryCount(): number {
		return this.retries;
	}

	private cancelReconnect(): void {
		this.reconnectController?.abort();
		this.reconnectController = undefined;
	}

	private beginConnect(url: string, timeout: number): ConnectAttempt {
		this.cancelReconnect();
		this.retries = 0;
		const controller = this.opts.autoReconnect ? new AbortController() : undefined;
		this.reconnectController = controller;
		const attempt = this._connect(url, timeout);
		if (controller) void this.reconnectAfter(attempt.promise, controller);
		return attempt;
	}

	private isReconnectActive(controller: AbortController): boolean {
		return this.reconnectController === controller && !controller.signal.aborted;
	}

	private async reconnectAfter(connection: Promise<[boolean, string]>, controller: AbortController): Promise<void> {
		let [connected] = await connection;
		while (!connected && this.isReconnectActive(controller)) {
			if (this.retries >= this.opts.backoff.maxRetries) {
				this.emitEvent('retries_exhausted', 'retries_exhausted');
				return;
			}
			const { baseMs, factor, maxMs, jitter } = this.opts.backoff;
			const raw = Math.min(maxMs, baseMs * Math.pow(factor, this.retries));
			const delayMs = Math.max(0, Math.floor(raw + raw * jitter * (Math.random() * 2 - 1)));
			const retry = ++this.retries;
			this.emitEvent('reconnect', retry);
			if (!this.isReconnectActive(controller)) return;
			try {
				await delay(delayMs, undefined, { signal: controller.signal });
			} catch (err) {
				if (controller.signal.aborted) return;
				throw err;
			}
			if (!this.isReconnectActive(controller)) return;
			[connected] = await this._connect(this.url, this.opts.connectTimeout).promise;
			if (!this.isReconnectActive(controller)) return;
			if (!connected) this.emitEvent('reconnect_fail', retry);
		}
	}

	get timeoutHandle(): ReturnType<typeof setTimeout> | null {
		return this.attempt?.timeoutHandle ?? null;
	}

	override isConnected(): boolean {
		return super.isConnected() && !!this.attempt?.connected && !this.attempt.failed && !this.attempt.disconnected;
	}

	get connected(): boolean {
		return this.isConnected();
	}

	override isConnecting(): boolean {
		return !!this.attempt && !this.attempt.connected && !this.attempt.failed &&
			(super.isConnecting() || super.isConnected());
	}

	connect(url: string, timeout = this.opts.connectTimeout) {
		if (!url) {
			return false;
		}
		if (this.url === url){
			if (this.isConnected() || (this.isConnecting() && !this.attempt?.failed)){
				return true;
			}
		}
		return !this.beginConnect(url, timeout).failed;
	}

	private _connect(url: string, timeout = 5000) {
		let resolve: ConnectAttempt['resolve'];
		const promise = new Promise<[boolean, string]>(resolver => { resolve = resolver; });
		const previous = this.attempt;
		const attempt: ConnectAttempt = {
			promise, resolve, timeoutHandle: null,
			connected: false, disconnected: false, failed: false,
		};
		this.attempt = attempt;
		this.ws = undefined;
		this.url = url;
		this.serverId = 0;
		this.sys = undefined;
		this.lastPong = Date.now();
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		if (previous) {
			this.closeTimeout(previous);
			previous.resolve([false, 'superseded']);
			if (previous.ws && previous.ws.readyState !== WebSocket.CLOSED) {
				this.closeSocket(previous.ws, SocketCloseCode.disconnect, 'superseded');
			}
		}
		if (timeout > 0) {
			this.opts.connectTimeout = timeout;
		}
		try {
			attempt.ws = this.opts.createSocket ? this.opts.createSocket(url) : new WebSocket(url);
		} catch (err) {
			this.emitConnectFail('error', err, attempt);
			if (this.attempt === attempt) this.emitEvent('error', '', err);
			return attempt;
		}
		this.ws = attempt.ws;
		this.ws.binaryType = 'arraybuffer';
		this.setup(attempt, timeout);
		return attempt;
	}

	connectPromise(url: string, timeout = this.opts.connectTimeout): Promise<[boolean, string]> {
		if (!url) {
			return Promise.resolve([false, 'empty url']);
		}
		if (this.url === url){
			if (this.isConnected()){
				return Promise.resolve([true, 'same url']);
			}
			if (this.isConnecting() && this.attempt && !this.attempt.failed) {
				return this.attempt.promise;
			}
		}

		return this.beginConnect(url, timeout).promise;
	}

	serverId = 0; // 在server端的id

	private sys: SocketSysMessage;
	getSys() {
		return this.sys;
	}

	private closeTimeout(attempt: ConnectAttempt){
		if (attempt.timeoutHandle){
			clearTimeout(attempt.timeoutHandle);
			attempt.timeoutHandle = null;
		}
	}

	private setup(attempt: ConnectAttempt, timeout: number) {
		const ws = attempt.ws;
		assert(ws)
		attempt.timeoutHandle = setTimeout(() => {
			if (this.attempt !== attempt) return;
			this.closeTimeout(attempt);
			if (!attempt.connected) {
				ws.close(SocketCloseCode.connect_timeout);
				this.emitConnectFail('timeout', undefined, attempt);
			}
		}, timeout || 5000); // 默认5秒超时

		ws.onopen = (ev) => {
			if (this.attempt !== attempt || attempt.failed) return;
			this.logger.info(this.logHead('onopen'));
		};

		ws.onmessage = (ev) => {
			if (this.attempt !== attempt || attempt.failed) return;
			this.onMessage(ev);
		};

		ws.onclose = (ev) => {
			if (this.attempt !== attempt) return;
			this.closeTimeout(attempt);
			this.logger.warn(this.logHead('onclose', 'warn'), ev?.reason);
			this.emitError('close', ev, attempt);
			if (this.attempt === attempt) this.emitEvent('close', '', ev);
		};

		ws.onerror = (err: any) => {
			if (this.attempt !== attempt) return;
			this.closeTimeout(attempt);
			const error = { ...err, message: err?.message || err?.reason };
			this.logger.error(this.logHead('onerror', 'error'), error?.message);
			this.emitError('error', error, attempt);
			if (this.attempt === attempt) this.emitEvent('error', '', error);
		};
	}

	override prevHandle(parsed: any) {
		if (super.prevHandle(parsed)) return true;
		if (parsed.eventName === 'system') {
			const attempt = this.attempt;
			if (!attempt || attempt.failed || attempt.connected) return true;
			const sys = parsed.data as SocketSysMessage;
			this.serverId = sys.id;
			this.sys = sys;
			attempt.connected = true;
			this.retries = 0;
			this.closeTimeout(attempt);
			this.lastPong = Date.now();
			this.startHeartbeat(attempt);
			attempt.resolve([true, '']);
			this.emitEvent('connect', this.opts.autoReconnect ? ++this.connectedTimes : undefined);
			return true;
		}
		return false;
	}

	override maxSendLen(): number {
		return this.sys?.maxSendLen;
	}

	override maxRecvLen(): number {
		return this.sys?.maxRecvLen;
	}

	//网络消息
	on(event: string, handler: MsgHandleFunc): this {
		const old = this.msgHandlers[event];
		if (old) {
			this.logger.warn(this.logHead('on', 'warn'), event, 'already registered');
		}
		this.msgHandlers[event] = handler;
		return this;
	}

	private onMessage(ev: any): void {
		let data: string;
		const payload = ev && typeof ev === 'object' && 'data' in ev ? ev.data : ev;
		if (typeof payload === 'string') {
			data = payload;
		} else if (payload instanceof ArrayBuffer) {
			data = new TextDecoder().decode(payload);
		} else if (ArrayBuffer.isView(payload)) {
			// Node Buffer、浏览器 TypedArray 均使用 UTF-8 解码。
			data = new TextDecoder().decode(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
		} else {
			this.logger.warn(this.logHead('onMessage', 'warn'), 'unknown message format:', ev);
			return;
		}

		const parsed = this.parseMessage(data);
		if (!parsed) return;

		if (this.prevHandle(parsed)) return;

		const handler = this.msgHandlers[parsed.eventName];
		if (handler) {
			handler(parsed.data);
		} else {
			this.logger.warn(
				this.logHead('onMessage', 'warn'),
				`no handler for event ${parsed.eventName}`,
				data,
			);
		}
	}

	//唯一的函数, 不用Event来实现
	private clientEventListeners: Record<string, ClientEventFunc> = {};
	// 一般不用, test用
	allEventFunc: AllClientEventFunc | undefined;

	//网络事件, 跟网络消息分开
	emitEvent(eventName: socketClientEvent, reason?: SocketReason, err?: any): void {
		const attempt = this.attempt;
		const fn = this.clientEventListeners[eventName];
		fn?.(reason, err);
		if (this.attempt === attempt) this.allEventFunc?.(eventName, reason, err);
	}

	onEvent(event: socketClientEvent, fn: ClientEventFunc): this {
		const old = this.clientEventListeners[event];
		if (old) {
			this.logger.warn(this.logHead('onEvent', 'warn'), event, 'already registered');
		}
		this.clientEventListeners[event] = fn;
		return this;
	}

	private clearAllEvent() {
		this.clientEventListeners = {};
		this.msgHandlers = {};
		this.allEventFunc = undefined;
	}

	private emitError(reason: 'close' | 'error', err: any, attempt: ConnectAttempt) {
		if (!attempt.connected) {
			this.emitConnectFail(reason, err, attempt);
		} else {
			this.emitDisconnect(reason, err);
		}
	}

	// 如果主程序主动检测到断线, 不必再触发'disconnect'事件
	// debug use only...
	suppressNextDisconnectEvent() {
		if (this.attempt) this.attempt.disconnected = true;
	}

	// 确保仅仅一次, 并且连上了connect之后才有disconnect, 否则是connect_fail
	emitDisconnect(reason: DisconnectReason, err?: any) {
		const attempt = this.attempt;
		if (!attempt || !attempt.connected || attempt.disconnected) return;
		attempt.disconnected = true;
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		const controller = this.reconnectController;
		this.emitEvent('disconnect', reason, err);
		if (controller && this.attempt === attempt && this.isReconnectActive(controller)) {
			void this.reconnectAfter(Promise.resolve([false, String(reason)]), controller);
		}
	}

	private emitConnectFail(reason: ConnectFailedReason, err: any, attempt: ConnectAttempt) {
		if (this.attempt !== attempt || attempt.failed) return;
		attempt.failed = true;
		attempt.resolve([false, reason]);
		this.emitEvent('connect_fail', reason, err);
	}

	private heartbeatTimer: any;

	private startHeartbeat(attempt: ConnectAttempt) {
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = setInterval(() => {
			if (this.attempt !== attempt) return;
			// 心跳检测逻辑
			const now = Date.now();
			const rt = this.heartBreak(now, this.opts.heartbeatTimeout);
			if (rt) {
				this.emitDisconnect(rt);
				if (this.attempt === attempt) this.emitEvent(rt);
				this.closeSocket(attempt.ws, SocketCloseCode.heartbreak, rt);
			}
		}, this.opts.heartbeatInterval);
	}

	private closeSocket(ws: WebSocket, code: SocketCloseCode, reason: string) {
		if (!ws) return;
		if (typeof ws.terminate === 'function') {
			// Node: ws (npm 'ws') 才有 terminate
			ws.terminate();
		} else {
			// Browser: 只有 close
			// 说明：应用自定义 close code 建议 4000~4999，reason 不能超过 123 字节
			ws.close(code, reason);
		}
	}

	getServerId() {
		return this.serverId;
	}

	override close(code = SocketCloseCode.normal, reason?: string): void {
		this.cancelReconnect();
		super.close(code, reason);
	}

	// 清理所有事件, 不再触发 'disconnect' 事件
	destroy() {
		this.cancelReconnect();
		const attempt = this.attempt;
		this.attempt = undefined;
		if (attempt) {
			this.closeTimeout(attempt);
			attempt.resolve([false, 'destroyed']);
		}
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		this.serverId = 0;
		this.sys = undefined;
		this.clearAllEvent();
		this.closeSocket(this.ws, SocketCloseCode.normal, 'destroy');
	}

	// 主动发起断线, 关闭重连
	override disconnect(code: SocketCloseCode = SocketCloseCode.disconnect, reason?: string) {
		this.opts.autoReconnect = false
		super.disconnect(code, reason);
	}
}
