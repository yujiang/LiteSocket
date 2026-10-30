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
// 1. 将 event 和 msg 分离，客户端网络事件通过跨平台 EventEmitter 分发
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
import { EventEmitter } from './EventEmitter';


/**
 * Server-side connection lifecycle and diagnostic names.
 */
export type clientEvent =
	| 'client-connect'
	| 'client-disconnect'
	| 'client-close'
	| 'client-error'
	| 'exception'
	| 'pong-timeout';

	
/**
 * Server lifecycle observer receiving the affected connection and reason.
 */
export type SocketEventFunc = (client: LiteServerClient, reason: SocketReason, err?: any) => void;
/**
 * Observer for broadcast serialization and size failures.
 */
export type ServerExceptionFunc = (reason: string, details: BroadcastExceptionDetails) => void;
/**
 * Listen outcome: [success, optional operating-system or TLS configuration error].
 */
export type ListenResult = [boolean, NodeJS.ErrnoException?];
/**
 * Connection wrapper constructor used for newly accepted sockets.
 */
export type ClientSocketClass = new (
	/**
	 * Human-readable diagnostic label.
	 */
	name: string,
	/**
	 * Injected diagnostic logger; console implements the required contract.
	 */
	logger: LiteLogger,
	/**
	 * Underlying WebSocket transport; may be unset before a client connection attempt.
	 */
	ws: WebSocket,
	/**
	 * Owning transport server.
	 */
	server: LiteServer,
	/**
	 * Server-assigned connection ID, unique within this server instance.
	 */
	id: number,
	/**
	 * TCP peer address; may contain an IPv4-mapped IPv6 prefix.
	 */
	remoteAddress?: string,
) => LiteServerClient;

/**
 * Node.js WS/WSS server with heartbeats, process-local rooms, and optional message rate limits.
 */
export class LiteServer {
	private nextClientId = 1;

	/**
	 * Finds an indexed connection by server-assigned ID, or returns undefined.
	 * @param id - Connection ID or RPC correlation number, as specified by this API.
	 */
	findById(id: number) {
		return this.clients.get(id);
	}

	/**
	 * Current connections indexed by server-assigned ID.
	 */
	clients: Map<number, LiteServerClient> = new Map();
	/**
	 * Underlying Node.js WebSocket server; released when the server closes.
	 */
	wss: WebSocketServer;
	private httpsServer?: HttpsServer;
	private httpsSockets = new Set<Socket>();

	/**
	 * Returns the number of indexed connections.
	 */
	clientsNum(): number {
		return this.clients.size;
	}

	private assignClientId(): number {
		// 这里考虑回归...
		return this.nextClientId++;
	}

	/**
	 * Human-readable diagnostic label.
	 */
	name: string;

	/**
	 * Actual listening port, including the OS-assigned port after listening on zero.
	 */
	port = 0;

	/**
	 * Transport options; clients expose resolved options through getOpts().
	 */
	opts: LiteOptions;
	/**
	 * Injected diagnostic logger; console implements the required contract.
	 */
	logger: LiteLogger;

	/**
	 * Creates LiteServer with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 * @param logger - Logger implementing LiteLogger; console is supported.
	 * @param opts - Transport overrides.
	 */
	constructor(
		name: string,
		logger: LiteLogger,
		opts: LiteOptionsInput = {},
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
	}

	clientFactory: ClientSocketClass;
	/**
	 * Sets the wrapper constructor for subsequently accepted connections.
	 */
	setClientFactory(factory: ClientSocketClass) {
		this.clientFactory = factory;
	}
	/**
	 * Wraps an accepted WebSocket using the configured connection factory.
	 * @param id - Connection ID or RPC correlation number, as specified by this API.
	 */
	createClient(ws: WebSocket, id: number, remoteAddress = '') {
		if (this.clientFactory){
			return new this.clientFactory(`${this.name}(${id})`, this.logger, ws, this, id, remoteAddress)
		}
		return new LiteServerClient(`${this.name}(${id})`, this.logger, ws, this, id, remoteAddress)
	}

	/**
	 * Starts WS/WSS listening without retries; returns [success, error]. Port zero requests an OS-assigned port.
	 * @param port - TCP port; zero requests an OS-assigned port.
	 */
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

	/**
	 * Returns the server diagnostic name including its listening port.
	 */
	getNameDisplay() {
		return this.name + ':' + this.port;
	}

	private logHead(func: string, logtype?: string) {
		return logHeadEx('LiteServer', this.getNameDisplay(), func, logtype);
	}

	private onConnect(ws: WebSocket, remoteAddress?: string) {
		const id = this.assignClientId();
		const client = this.createClient(ws, id, remoteAddress);
		this.logger.info(this.logHead('onConnect'), 'id:', id);
		this.clients.set(id, client);
		const sys = { id, maxSendLen: this.opts.maxRecvLen, maxRecvLen: this.opts.maxSendLen };
		client.emit('system', sys);
		this.emitClient('client-connect', client);
	}

	private clientEvents = new EventEmitter<clientEvent, [client: LiteServerClient, reason?: SocketReason, err?: any]>();
	private exceptionEvents = new EventEmitter<'exception', [reason: string, details: BroadcastExceptionDetails]>();

	/**
	 * Adds a lifecycle/diagnostic listener; multiple listeners are supported.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param handler - Handler for this registration.
	 */
	onEvent(event: 'exception', handler: ServerExceptionFunc): void {
		this.exceptionEvents.on(event, handler);
	}

	/**
	 * Encodes once and checks size; failure emits an exception and returns undefined.
	 * @param eventName - Transport category or lifecycle name.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param room - Process-local room name.
	 */
	encodeBroadcast(eventName: string, data: any, room?: string): string | undefined {
		const details: BroadcastExceptionDetails = { eventName, limit: this.opts.maxSendLen };
		if (room !== undefined) details.room = room;
		let message: string;
		try {
			message = LiteSocket.encodeMessage(eventName, data);
		} catch (error) {
			details.error = error;
			this.logger.error(this.logHead('broadcast', 'error'), msgJsonStringError, error);
			this.exceptionEvents.emit('exception', msgJsonStringError, details);
			return;
		}
		if (message.length >= details.limit) {
			details.length = message.length;
			this.logger.warn(this.logHead('broadcast', 'warn'), msgSendMax, details);
			this.exceptionEvents.emit('exception', msgSendMax, details);
			return;
		}
		return message;
	}

	onClientClose(client: LiteServerClient, reason?: SocketReason, err?: any){
		this.logger.warn(this.logHead('client-close', 'warn'), 'id:', client.id, "reason:", reason);
		this.clients.delete(client.id);
		this.leaveAllRooms(client);
	}

	/**
	 * Dispatches a lifecycle event and cleans connection/room indexes on client-close.
	 * @param eventName - Transport category or lifecycle name.
	 * @param client - Server-side connection.
	 * @param reason - Diagnostic or close reason.
	 */
	emitClient(eventName: clientEvent, client: LiteServerClient, reason?: SocketReason, err?: any): void {
		if (eventName === 'client-close') this.onClientClose(client, reason, err);
		this.clientEvents.emit(eventName, client, reason, err);
	}

	/**
	 * Adds a server connection lifecycle listener; multiple listeners are supported.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param handler - Handler for this registration.
	 */
	onClient(event: clientEvent, handler: SocketEventFunc): void {
		this.clientEvents.on(event, handler);
	}

	/**
	 * Encodes once and sends to connected clients matching the filter; direct send errors may propagate.
	 * @param eventName - Transport category or lifecycle name.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param filterFn - Optional predicate selecting recipients.
	 * @param client - Server-side connection.
	 */
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
	/**
	 * Registers one server-wide transport handler per event; duplicates replace it.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param handler - Handler for this registration.
	 * @param client - Server-side connection.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 */
	onMessage(event: string, handler: (client: LiteServerClient, data?: any) => void): void {
		const old = this.msgHandlers[event];
		if (old) {
			this.logger.warn(this.logHead('onMessage', 'warn'), `event ${event} already registered`);
		}
		this.msgHandlers[event] = handler;
	}

	/**
	 * Dispatches a decoded event to a server-wide handler; false means no handler exists.
	 * @param client - Server-side connection.
	 * @param eventName - Transport category or lifecycle name.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 */
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

	/**
	 * Stops listening, closes connections, clears handlers and heartbeat timers, and releases memberships.
	 */
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
		this.clientEvents.removeAllListeners();
		this.exceptionEvents.removeAllListeners();
	}

	// room start...
	private rooms = new RoomManager(this);

	/**
	 * Looks up an existing local room; may return undefined at runtime.
	 * @param room - Process-local room name.
	 */
	getRoom(room: string): LiteRoom {
		return this.rooms.get(room);
	}

	/**
	 * Adds a connection to a local room, creating the room if absent.
	 * @param room - Process-local room name.
	 * @param client - Server-side connection.
	 */
	joinRoom(room: string, client: LiteServerClient): void {
		this.rooms.join(room, client);
	}

	/**
	 * Removes a room from the manager without disconnecting members.
	 * @param room - Process-local room name.
	 */
	dismissRoom(room: string): void {
		this.rooms.dismiss(room);
	}

	/**
	 * Removes membership and deletes the room if it becomes empty.
	 * @param room - Process-local room name.
	 * @param client - Server-side connection.
	 */
	leaveRoom(room: string, client: LiteServerClient): void {
		this.rooms.leave(room, client);
	}

	private leaveAllRooms(client: LiteServerClient): void {
		this.rooms.leaveAll(client);
	}

	/**
	 * Applies join, leave, or dismiss; unknown operations are ignored.
	 * @param room - Process-local room name.
	 * @param client - Server-side connection.
	 */
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

	/**
	 * Applies a room operation by connection ID; unknown IDs/operations are ignored.
	 * @param room - Process-local room name.
	 * @param clientId - Server-assigned connection ID.
	 */
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
	/**
	 * Requests disconnection by ID; returns whether the connection exists.
	 * @param id - Connection ID or RPC correlation number, as specified by this API.
	 * @param reason - Diagnostic or close reason.
	 */
	kickoff(id: number, reason = 'kickoff'): boolean {
		this.logger.warn(this.logHead('kickoff', 'warn'), 'id:', id, 'reason:', reason);
		const client = this.findById(id);
		client?.disconnect(SocketCloseCode.disconnect, reason);
		return !!client;
	}

	// 正常退出
	/**
	 * Requests disconnection with reason exit; returns whether the connection exists.
	 * @param id - Connection ID or RPC correlation number, as specified by this API.
	 */
	exit(id: number){
		const client = this.findById(id);
		client?.disconnect(SocketCloseCode.disconnect, 'exit');
		return !!client;
	}

	// 监控玩家的所有消息
	/**
	 * Attaches incoming-message diagnostics; server lookup returns whether the connection exists.
	 * @param id - Connection ID or RPC correlation number, as specified by this API.
	 */
	observe(id: number, log:LiteLogger) : boolean {
		const client = this.findById(id);
		client?.observe(log);
		return !!client;
	}
}
