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
// 1. 将 event 和 msg 分开， event使用EventEmitter, 而msg只有一个handle
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
import { LiteSocket, SocketMsgType, SocketReason } from './LiteSocket';
import { strict as assert } from 'node:assert';
import { EventEmitter } from './EventEmitter';

/**
 * Lifecycle observer receiving a reason and optional error context.
 */
export type ClientEventFunc = (resaon: SocketReason, err?: any) => void;
/**
 * Diagnostic observer receiving every client lifecycle event.
 */
export type AllClientEventFunc = (
	event: string,
	resaon: SocketReason, // number only for retrytimes
	err?: Error,
) => void;
/**
 * Transport message callback receiving the decoded payload.
 */
export type MsgHandleFunc = (data?: any) => void;

/**
 * Exponential reconnect delay settings; reconnect does not replay requests or restore business state.
 */
export type BackoffOptions = {
	/**
	 * Initial reconnect delay before jitter, in milliseconds.
	 * @defaultValue 800
	 */
	baseMs?: number;
	/**
	 * Maximum exponential delay before jitter, in milliseconds.
	 * @defaultValue 15000
	 */
	maxMs?: number;
	/**
	 * Delay multiplier for each failed reconnect attempt.
	 * @defaultValue 2
	 */
	factor?: number;
	/**
	 * Symmetric relative delay variation; 0.25 allows up to 25 percent in either direction.
	 * @defaultValue 0.25
	 */
	jitter?: number;
	/**
	 * Maximum reconnect attempts after connection failure.
	 * @defaultValue Infinity
	 */
	maxRetries?: number;
};

/**
 * Resolved client configuration, including merged backoff defaults.
 */
export interface LiteClientOptions {
	/**
	 * Heartbeat check interval in milliseconds.
	 * @defaultValue 10000
	 */
	heartbeatInterval: number;
	/**
	 * Maximum pong age accepted at a heartbeat check, in milliseconds.
	 * @defaultValue 15000
	 */
	heartbeatTimeout: number;
	/**
	 * Timeout for WebSocket opening and the system handshake, in milliseconds.
	 * @defaultValue 5000
	 */
	connectTimeout: number;
	/**
	 * Enables reconnects without replaying requests or restoring business state.
	 * @defaultValue false
	 */
	autoReconnect: boolean;
	backoff: Required<BackoffOptions>;
	/**
	 * Reserved debug option; currently does not alter transport behavior.
	 */
	debug?: boolean;
	/**
	 * Optional WebSocket factory for adapters or tests; defaults to the platform transport.
	 */
	createSocket?: (url: string) => WebSocket; 
}

/**
 * Optional client transport and reconnect overrides.
 */
export interface LiteClientOptionsInput {
	/**
	 * Heartbeat check interval in milliseconds.
	 * @defaultValue 10000
	 */
	heartbeatInterval?: number;
	/**
	 * Maximum pong age accepted at a heartbeat check, in milliseconds.
	 * @defaultValue 15000
	 */
	heartbeatTimeout?: number;
	/**
	 * Timeout for WebSocket opening and the system handshake, in milliseconds.
	 * @defaultValue 5000
	 */
	connectTimeout?: number;
	/**
	 * Enables reconnects without replaying requests or restoring business state.
	 * @defaultValue false
	 */
	autoReconnect?: boolean;
	backoff?: BackoffOptions;
	/**
	 * Reserved debug option; currently does not alter transport behavior.
	 */
	debug?: boolean;
	/**
	 * Optional WebSocket factory for adapters or tests; defaults to the platform transport.
	 */
	createSocket?: (url: string) => WebSocket; // brower用Windows.WebSocket
}

interface ConnectAttempt {
	/**
	 * Underlying WebSocket transport; may be unset before a client connection attempt.
	 */
	ws?: WebSocket;
	promise: Promise<[boolean, string]>;
	resolve: (result: [boolean, string]) => void;
	timeoutHandle: ReturnType<typeof setTimeout> | null;
	connected: boolean;
	disconnected: boolean;
	failed: boolean;
}

/**
 * WebSocket client with system-handshake readiness and optional exponential-backoff reconnects.
 */
export class LiteClient extends LiteSocket implements CommonClient {
	private msgHandlers: Record<string, MsgHandleFunc> = Object.create(null);
	url: string;
	private opts: LiteClientOptions;

	/**
	 * Creates LiteClient with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 * @param logger - Logger implementing LiteLogger; console is supported.
	 * @param opts - Transport overrides.
	 */
	constructor(name: string, logger: LiteLogger, opts: LiteClientOptionsInput = {}) {
		super(name, logger);
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

	/**
	 * Returns the mutable resolved transport options.
	 */
	getOpts() {
		return this.opts;
	}

	private attempt?: ConnectAttempt;
	private reconnectController?: AbortController;
	private disconnectFunc?: ClientEventFunc;
	private retries = 0;
	private connectedTimes = 0;

	/**
	 * Returns attempts in the current reconnect cycle; resets on success.
	 */
	getRetryCount(): number {
		return this.retries;
	}

	private _cancelReconnect(): void {
		this.reconnectController?.abort();
		this.reconnectController = undefined;
	}

	/**
	 * Cancels retry waits and disables reconnect without closing the active socket.
	 */
	cancelReconnect() {
		this.opts.autoReconnect = false
		this._cancelReconnect();
	}

	private beginConnect(url: string, timeout: number): ConnectAttempt {
		this._cancelReconnect();
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

	/**
	 * Reports whether this connection is usable; clients additionally require the system handshake.
	 */
	override isConnected(): boolean {
		return super.isConnected() && !!this.attempt?.connected && !this.attempt.failed && !this.attempt.disconnected;
	}

	get connected(): boolean {
		return this.isConnected();
	}

	/**
	 * Reports whether a connection attempt is still awaiting readiness.
	 */
	override isConnecting(): boolean {
		return !!this.attempt && !this.attempt.connected && !this.attempt.failed &&
			(super.isConnecting() || super.isConnected());
	}

	/**
	 * Starts or reuses a connection attempt; the boolean indicates attempt acceptance, not completed readiness.
	 * @param url - WebSocket endpoint using ws:// or wss://.
	 * @param timeout - Connection and system-handshake timeout in milliseconds; defaults to connectTimeout (5000).
	 */
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

	/** Calls disconnect after an established connection is lost; initial connection failures do not call it.
	 * @param url - WebSocket endpoint using ws:// or wss://.
	 * @param disconnect - Observer for established connection loss; initial failures do not invoke it.
	 * @param timeout - Connection and system-handshake timeout in milliseconds; defaults to connectTimeout (5000).
	 * @returns Promise resolving to [connected, reason] after the system handshake or connection failure.
	 */
	connectPromise(url: string, disconnect: ClientEventFunc, timeout?: number): Promise<[boolean, string]>;
	/**
	 * Waits for WebSocket opening and the system handshake; resolves to [connected, reason].
	 * @param url - WebSocket endpoint using ws:// or wss://.
	 * @param timeout - Connection and system-handshake timeout in milliseconds; defaults to connectTimeout (5000).
	 * @returns Promise resolving to [connected, reason] after the system handshake or connection failure.
	 */
	connectPromise(url: string, timeout?: number): Promise<[boolean, string]>;
	/**
	 * Waits for WebSocket opening and the system handshake; resolves to [connected, reason].
	 * @param url - WebSocket endpoint using ws:// or wss://.
	 * @param disconnectOrTimeout - Disconnect observer or connection timeout in milliseconds.
	 * @param timeout - Connection and system-handshake timeout in milliseconds; defaults to connectTimeout (5000).
	 * @returns Promise resolving to [connected, reason] after the system handshake or connection failure.
	 */
	connectPromise(
		url: string,
		disconnectOrTimeout?: ClientEventFunc | number,
		timeout = this.opts.connectTimeout,
	): Promise<[boolean, string]> {
		if (!url) {
			return Promise.resolve([false, 'empty url']);
		}
		if (typeof disconnectOrTimeout === 'function') {
			this.disconnectFunc = disconnectOrTimeout;
		} else if (typeof disconnectOrTimeout === 'number') {
			timeout = disconnectOrTimeout;
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

	/**
	 * Server-assigned connection ID; zero until the system handshake completes.
	 */
	serverId = 0; // 在server端的id

	private sys: SocketSysMessage;
	/**
	 * Returns system handshake data, or undefined before readiness.
	 */
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

	/**
	 * Consumes protocol control messages before business dispatch; returns whether the packet was handled.
	 */
	override prevHandle(parsed: SocketMsgType) {
		if (super.prevHandle(parsed)) return true;
		if (parsed.e === 'system') {
			const attempt = this.attempt;
			if (!attempt || attempt.failed || attempt.connected) return true;
			const sys = parsed.d as SocketSysMessage;
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

	/**
	 * Returns the outgoing JSON string-length limit in UTF-16 code units.
	 */
	override maxSendLen(): number {
		return this.sys?.maxSendLen;
	}

	/**
	 * Returns the incoming JSON string-length limit in UTF-16 code units.
	 */
	override maxRecvLen(): number {
		return this.sys?.maxRecvLen;
	}

	//网络消息
	/**
	 * Registers one transport-message handler per event; duplicate registration replaces it.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param handler - Handler for this registration.
	 */
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

		const handler = this.msgHandlers[parsed.e];
		if (handler) {
			handler(parsed.d);
		} else {
			this.logger.warn(
				this.logHead('onMessage', 'warn'),
				`no handler for event [${parsed.e}]`,
				data,
			);
		}
	}

	private clientEvents = new EventEmitter<socketClientEvent, [reason?: SocketReason, err?: any]>();
	// 一般不用, test用
	/**
	 * Optional observer for every client lifecycle event, primarily for diagnostics.
	 */
	allEventFunc: AllClientEventFunc | undefined;

	//网络事件, 跟网络消息分开
	/**
	 * Dispatches a lifecycle or diagnostic event to observers.
	 * @param eventName - Transport category or lifecycle name.
	 * @param reason - Diagnostic or close reason.
	 */
	emitEvent(eventName: socketClientEvent, reason?: SocketReason, err?: any): void {
		const attempt = this.attempt;
		this.clientEvents.emit(eventName, reason, err);
		if (this.attempt === attempt) this.allEventFunc?.(eventName, reason, err);
	}

	/**
	 * Adds a lifecycle/diagnostic listener; multiple listeners are supported.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param fn - Lifecycle observer.
	 */
	onEvent(event: socketClientEvent, fn: ClientEventFunc): this {
		this.clientEvents.on(event, fn);
		return this;
	}

	private clearAllEvent() {
		this.clientEvents.removeAllListeners();
		this.msgHandlers = Object.create(null);
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
	/**
	 * Suppresses subsequent disconnect notification by marking the attempt disconnected; intended for diagnostics.
	 */
	suppressNextDisconnectEvent() {
		if (this.attempt) this.attempt.disconnected = true;
	}

	// 确保仅仅一次, 并且连上了connect之后才有disconnect, 否则是connect_fail
	/**
	 * Reports established connection loss at most once for the current connection.
	 * @param reason - Diagnostic or close reason.
	 */
	emitDisconnect(reason: DisconnectReason, err?: any) {
		const attempt = this.attempt;
		if (!attempt || !attempt.connected || attempt.disconnected) return;
		attempt.disconnected = true;
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		const controller = this.reconnectController;
		const disconnectFunc = this.disconnectFunc;
		this.emitEvent('disconnect', reason, err);
		disconnectFunc?.(reason, err);
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

	/**
	 * Returns the server-assigned connection ID, or zero before readiness.
	 */
	getServerId() {
		return this.serverId;
	}

	/**
	 * Disables reconnect and requests a closing handshake; established connections still report disconnect.
	 * @param reason - Diagnostic or close reason.
	 * @param code - Application WebSocket close code.
	 */
	override close(code = SocketCloseCode.normal, reason?: string): void {
		this.cancelReconnect();
		super.close(code, reason);
	}

	// 清理所有事件, 不再触发 'disconnect' 事件
	/**
	 * Cancels connection/reconnect work and clears handlers and timers without lifecycle notifications.
	 */
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
		this.disconnectFunc = undefined;
		this.clearAllEvent();
		this.closeSocket(this.ws, SocketCloseCode.normal, 'destroy');
	}

	// 主动发起断线, 一般只用于调试
	/**
	 * Disables reconnect and requests a closing handshake; established connections report disconnect.
	 * @param code - Application WebSocket close code.
	 * @param reason - Diagnostic or close reason.
	 */
	override disconnect(code: SocketCloseCode = SocketCloseCode.disconnect, reason?: string) {
		// 关闭重连
		this.cancelReconnect();
		super.disconnect(code, reason);
	}
}
