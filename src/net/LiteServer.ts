// liteServer.ts - 模拟 socket.io 的服务器端
//
// 外部只需关心事件：'client-connect' 和 'client-disconnect'
// 其他事件仅用于内部诊断。
// 
// 特别保证：
// - 'client-disconnect' 只会触发一次，且在系统事件（close/error/pong-timeout）之前触发
// - disconnect 的 reason 包括：error, close, pong-timeout
//
// 与 socket.io 的一致点：
// 1. 'client-connect' ≈ socket.io 的 'connect'
//    'client-disconnect' ≈ socket.io 的 'disconnect'
// 2. 支持 Room 概念，支持房间管理和广播
//
// 与 socket.io 的差异：
// 1. 将 event 和 msg 分离，每个事件仅支持一个回调函数（不使用 Node.js EventEmitter 模式）
// 2. 日志输出格式统一（通过 logHeadEx）
// 3. 支持消息大小上限：服务器会通过 system 消息告知客户端上限，
//    客户端若发送超过该上限的消息将被拒绝


import { WebSocketServer, WebSocket } from 'ws';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer, Server as HttpsServer } from 'node:https';
import { Socket } from 'node:net';
import { LiteServerClient } from './LiteServerClient';
import { LiteRoom, RoomManager } from './LiteRoom';
import { BroadcastExceptionDetails, LiteOptions, LiteOptionsInput, logHeadEx, msgJsonStringError, msgSendMax, SocketCloseCode } from './LiteNet';
import { LiteLogger } from "../public/log";
import { LiteSocket, SocketReason } from './LiteSocket';


export type clientEvent =
	| 'client-connect'
	| 'client-disconnect'
	| 'client-close'
	| 'client-error'
	| 'exception'
	| 'pong-timeout';

	
export type SocketEventFunc = (client: LiteServerClient, reason: SocketReason, err?: any) => void;
export type ServerExceptionFunc = (reason: string, details: BroadcastExceptionDetails) => void;
export type ListenResult = [boolean, NodeJS.ErrnoException?];
export type ServerClientFactory = (
	ws: WebSocket, server: LiteServer, id: number, remoteAddress?: string,
) => LiteServerClient;

export class LiteServer {
	private nextClientId = 1;

	findById(id: number) {
		return this.clients.get(id);
	}

	clients: Map<number, LiteServerClient> = new Map();
	wss: WebSocketServer;
	private httpsServer?: HttpsServer;
	private httpsSockets = new Set<Socket>();

	clientsNum(): number {
		return this.clients.size;
	}

	private assignClientId(): number {
		// 这里考虑回归...
		return this.nextClientId++;
	}

	name: string;

	port = 0;

	opts: LiteOptions;
	logger: LiteLogger;
	private readonly clientFactory: ServerClientFactory;

	constructor(
		name: string,
		logger: LiteLogger,
		opts: LiteOptionsInput = {},
		clientFactory: ServerClientFactory = (ws, server, id, address) =>
			new LiteServerClient(`${server.name}(${id})`, server.logger, ws, server, id, address),
	) {
		const limit = opts.messageRateLimit;
		if (limit && (!Number.isFinite(limit.perSecond) || limit.perSecond <= 0 ||
			!Number.isSafeInteger(limit.burst) || limit.burst < 1)) {
			throw new RangeError('messageRateLimit requires a positive perSecond and a positive integer burst');
		}
		this.opts = {
			heartbeatInterval: 10000,
			heartbeatTimeout: 15000,
			maxSendLen: 1024 * 1024,
			maxRecvLen: 1024 * 1024,
			...opts,
		};

		this.name = name;
		this.logger = logger;
		this.clientFactory = clientFactory;
	}

	async listenPromise(port: number): Promise<ListenResult> {
		this.port = port;
		try {
			const { keyfile, certfile } = this.opts;
			if (keyfile !== undefined || certfile !== undefined) {
				if (typeof keyfile !== 'string' || !keyfile || typeof certfile !== 'string' || !certfile) {
					throw Object.assign(new Error('WSS requires both keyfile and certfile'), { code: 'ERR_TLS_CONFIG' });
				}
				let server = createHttpsServer({ key: readFileSync(keyfile), cert: readFileSync(certfile) }, (_req, res) => {
					res.writeHead(426);
					res.end('WebSocket upgrade required');
				});
				
				// 重要: 见https://github.com/issues/created?q=is%3Aissue+state%3Aclosed+archived%3Afalse+author%3A%40me+sort%3Aupdated-desc&issue=nodejs%7Cnode%7C59193&issue_global_id=I_kwDOAZ7xs87CSS9K
				server.keepAliveTimeout = 60000;    // 保持连接 60 秒
				server.headersTimeout = 65000;       // 包头超时 65 秒
				
				server.on('connection', socket => {
					if (!(socket instanceof Socket)) return;
					this.httpsSockets.add(socket);
					socket.once('close', () => this.httpsSockets.delete(socket));
				});
				this.httpsServer = server;
				this.wss = new WebSocketServer({ server: this.httpsServer });
			} else {
				this.wss = new WebSocketServer({ port });
			}
			this.wss.on('connection', (ws: WebSocket, request) => {
				this.onConnect(ws, request.socket.remoteAddress);
			});
			this.httpsServer?.listen(port);
			await once(this.wss, 'listening');
			this.wss.on('error', error => this.logger.error(this.logHead('error', 'error'), error));
			const address = this.wss.address();
			if (address && typeof address === 'object') this.port = address.port;
			this.startHeartbeat();
			return [true];
		} catch (error) {
			this.close();
			return [false, error as NodeJS.ErrnoException];
		}
	}

	getNameDisplay() {
		return this.name + ':' + this.port;
	}

	private logHead(func: string, logtype?: string) {
		return logHeadEx('LiteServer', this.getNameDisplay(), func, logtype);
	}

	private onConnect(ws: WebSocket, remoteAddress?: string) {
		const id = this.assignClientId();
		const client = this.clientFactory(ws, this, id, remoteAddress);
		this.logger.info(this.logHead('onConnect'), 'id:', id);
		this.clients.set(id, client);
		const sys = { id, maxSendLen: this.opts.maxRecvLen, maxRecvLen: this.opts.maxSendLen };
		client.emit('system', sys);
		this.emitClient('client-connect', client);
	}

	//唯一的函数, 不用Event来实现
	private clientEventListeners: Record<string, SocketEventFunc> = Object.create(null);
	private exceptionHandler?: ServerExceptionFunc;

	onEvent(event: 'exception', handler: ServerExceptionFunc): void {
		if (this.exceptionHandler) {
			this.logger.warn(this.logHead('onEvent', 'warn'), event, 'already registered');
		}
		this.exceptionHandler = handler;
	}

	encodeBroadcast(eventName: string, data: any, room?: string): string | undefined {
		const details: BroadcastExceptionDetails = { eventName, limit: this.opts.maxSendLen };
		if (room !== undefined) details.room = room;
		let message: string;
		try {
			message = LiteSocket.encodeMessage(eventName, data);
		} catch (error) {
			details.error = error;
			this.logger.error(this.logHead('broadcast', 'error'), msgJsonStringError, error);
			this.exceptionHandler?.(msgJsonStringError, details);
			return;
		}
		if (message.length >= details.limit) {
			details.length = message.length;
			this.logger.warn(this.logHead('broadcast', 'warn'), msgSendMax, details);
			this.exceptionHandler?.(msgSendMax, details);
			return;
		}
		return message;
	}

	emitClient(eventName: clientEvent, client: LiteServerClient, reason?: SocketReason, err?: any): void {
		if (eventName === 'client-close') {
			this.logger.warn(this.logHead(eventName, 'warn'), 'id:', client.id, "reason:", reason);
			this.clients.delete(client.id);
			this.leaveAllRooms(client);
		}

		const fn = this.clientEventListeners[eventName];
		if (fn) {
			fn(client, reason, err);
		}
	}

	onClient(event: clientEvent, handler: SocketEventFunc): void {
		const old = this.clientEventListeners[event];
		if (old) {
			this.logger.warn(
				this.logHead('onClient', 'warn'),
				`clientevent ${event} already registered`,
			);
		}
		this.clientEventListeners[event] = handler;
	}

	broadcast(
		eventName: string,
		data: any,
		filterFn?: (client: LiteServerClient) => boolean,
	): void {
		const message = this.encodeBroadcast(eventName, data);
		if (message === undefined) return;
		this.clients.forEach((client) => {
			if (!client.isConnected()) return;
			if (filterFn && !filterFn(client)) return;
			client.wsSend(message);
		});
	}

	private handle: NodeJS.Timeout;
	private startHeartbeat(): void {
		this.handle = setInterval(() => this.performHeartbeatCheck(), this.opts.heartbeatInterval);
	}

	private performHeartbeatCheck(): void {
		const now = Date.now();
		this.clients.forEach((client) => {
			const rt = client.heartBreak(now, this.opts.heartbeatTimeout)
			if (rt) {
				client.emitDisconnect(rt);
				this.emitClient(rt, client);
				client.terminate();
			}
		});
	}

	//唯一的函数, 不用Event来实现
	msgHandlers: Record<string, (client: LiteServerClient, data?: any) => void> = Object.create(null);
	onMessage(event: string, handler: (client: LiteServerClient, data?: any) => void): void {
		const old = this.msgHandlers[event];
		if (old) {
			this.logger.warn(this.logHead('onMessage', 'warn'), `event ${event} already registered`);
		}
		this.msgHandlers[event] = handler;
	}

	handleClientMsg(client: LiteServerClient, eventName: string, data: any): boolean {
		const handler = this.msgHandlers[eventName];
		if (handler) {
			handler(client, data);
			return true;
		} else {
			this.logger.warn(
				this.logHead('handleClientMsg', 'warn'),
				`no handler for event [${eventName}]`,
				this.getNameDisplay(),
				client.id,
				data,
			);
			return false;
		}
	}

	close() {
		if (this.handle) {
			clearInterval(this.handle);
			this.handle = null;
		}
		
		// client will get 'close' event
		this.clients.forEach((client) => {
			client.close();
			client.dispose('server close');
			this.leaveAllRooms(client);
		});
		this.clients.clear();

		this.wss?.close();
		this.wss = null;
		// 外部 HTTPS Server 不会随 WebSocketServer.close() 自动关闭。
		this.httpsServer?.close();
		this.httpsServer = undefined;
		for (const socket of this.httpsSockets) socket.destroySoon();
		this.httpsSockets.clear();
		this.msgHandlers = Object.create(null);
		this.clientEventListeners = Object.create(null);
		this.exceptionHandler = undefined;
	}

	// room start...
	private rooms = new RoomManager(this);

	getRoom(room: string): LiteRoom {
		return this.rooms.get(room);
	}

	joinRoom(room: string, client: LiteServerClient): void {
		this.rooms.join(room, client);
	}

	dismissRoom(room: string): void {
		this.rooms.dismiss(room);
	}

	leaveRoom(room: string, client: LiteServerClient): void {
		this.rooms.leave(room, client);
	}

	private leaveAllRooms(client: LiteServerClient): void {
		this.rooms.leaveAll(client);
	}

	opRoom(op: string, room: string, client: LiteServerClient): void {
		switch(op){
			case 'join':
				this.joinRoom(room, client);
				break;
			case 'leave':
				this.leaveRoom(room, client);
				break;
			case 'dismiss':
				this.dismissRoom(room);
				break;			
			default:
		}
	}

	opRoomId(op: string, room: string, clientId: number): void {
		if (op === 'dismiss') {
			this.dismissRoom(room);
			return
		}
		const client = this.findById(clientId);
		if (!client) return;
		switch(op){
			case 'join':
				this.joinRoom(room, client);
				break;
			case 'leave':
				this.leaveRoom(room, client);
				break;
			default:
		}
	}


	// room end...

	// 服务器主动踢掉客户端, 类似GM踢人
	kickoff(id: number, reason = 'kickoff'): boolean {
		this.logger.warn(this.logHead('kickoff', 'warn'), 'id:', id, 'reason:', reason);
		const client = this.findById(id);
		client?.disconnect(SocketCloseCode.disconnect, reason);
		return !!client;
	}

	// 正常退出
	exit(id: number){
		const client = this.findById(id);
		client?.disconnect(SocketCloseCode.disconnect, 'exit');
		return !!client;
	}

	// 监控玩家的所有消息
	observe(id: number, log:LiteLogger) : boolean {
		const client = this.findById(id);
		client?.observe(log);
		return !!client;
	}
}
