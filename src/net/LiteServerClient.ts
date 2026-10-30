// LiteServerClient 外部不需要关心, LiteServer使用

import { WebSocket, RawData } from 'ws';
import { performance } from 'node:perf_hooks';
import { clientEvent, LiteServer } from './LiteServer';
import type { MessageRateLimit } from './LiteNet';
import type { LiteLogger } from "../public/log";
import { CommonSocket, DisconnectReason } from './LiteNet';
import { LiteSocket } from './LiteSocket';

function raw2String(raw: RawData): string {
	if (typeof raw === 'string') return raw;
	if (Buffer.isBuffer(raw)) return  raw.toString();
	if (raw instanceof ArrayBuffer) {
		const buf = Buffer.from(raw);
		return buf.toString();
	}
	if (Array.isArray(raw)) {
		const buf = Buffer.concat(raw);
		return buf.toString();
	}
	return null;
}


/**
 * One accepted connection with local message handlers, room membership, and diagnostics.
 */
export class LiteServerClient extends LiteSocket implements CommonSocket{
	/**
	 * Server-assigned connection ID, unique within this server instance.
	 */
	id: number;
    /**
     * Application-owned data attached to this connection.
     */
    customData: any //存储数据用

	/**
	 * Owning transport server.
	 */
	readonly server: LiteServer;
	/**
	 * TCP peer address; may contain an IPv4-mapped IPv6 prefix.
	 */
	readonly remoteAddress: string;
	private handlers = new Map<string | symbol, (data?: any) => void>();
	private disposed = false;
	private messageTokens = 0;
	private lastMessageTime = performance.now();

	/**
	 * Creates LiteServerClient with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 * @param logger - Logger implementing LiteLogger; console is supported.
	 * @param id - Connection ID or RPC correlation number, as specified by this API.
	 */
	constructor(name: string, logger: LiteLogger, ws: WebSocket, server: LiteServer, id: number, remoteAddress = '') {
		super(name, logger);
		this.ws = ws;
		this.server = server;
		this.id = id;
		this.remoteAddress = remoteAddress;
		this.messageTokens = server.opts.messageRateLimit?.burst ?? 0;

		ws.on('message', (msg) => this.handleMessage(msg));
		ws.on('close', (code, reasonBuffer) => {
			const reason = reasonBuffer.toString() || '';
			this.emitDisconnect('close', { code, reason });
			this.server.emitClient('client-close', this, reason , { code, reason });
		});
		ws.on('error', (err: Error) => {
			this.emitDisconnect('error', err);
			this.server.emitClient('client-error', this, err.message, err);
		});
	}

	/**
	 * Reports whether this connection is usable; clients additionally require the system handshake.
	 */
	override isConnected(): boolean {
		return !this.disconnected && !this.disposed && super.isConnected();
	}

	get connected(): boolean {
		return this.isConnected();
	}

	/**
	 * Registers one connection-local transport handler per event; duplicates replace it.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param handler - Handler for this registration.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 */
	on(event: string | symbol, handler: (data?: any) => void): this {
		if (this.handlers.has(event)) {
			this.logger.warn(this.logHead('on', 'warn'), event, 'already registered');
		}
		this.handlers.set(event, handler);
		return this;
	}

	/**
	 * Adds local room membership; room managers create missing rooms.
	 * @param room - Process-local room name.
	 */
	join(room: string): void {
		if (this.isConnected()) this.server.joinRoom(room, this);
	}

	/**
	 * Removes room membership; managers delete rooms left empty.
	 * @param room - Process-local room name.
	 */
	leave(room: string): void {
		this.server.leaveRoom(room, this);
	}

	/**
	 * Clears local handlers/resources once; false means already disposed. Does not itself close the transport.
	 * @param reason - Diagnostic or close reason.
	 */
	dispose(reason?: string): boolean {
		if (this.disposed) return false;
		this.disposed = true;
		this.handlers.clear();
		return true;
	}

	//不是消息是事件
	/**
	 * Dispatches a lifecycle or diagnostic event to observers.
	 * @param eventName - Transport category or lifecycle name.
	 * @param reason - Diagnostic or close reason.
	 */
	emitEvent(eventName: clientEvent, reason?: string | number, err?: any){
		this.server.emitClient(eventName, this, reason, err);
	}

	private disconnected = false;
	// 确保仅仅一次
	/**
	 * Reports established connection loss at most once for the current connection.
	 * @param reason - Diagnostic or close reason.
	 */
	emitDisconnect(reason: DisconnectReason, err?: any) {
		if (this.disconnected) return;
		this.disconnected = true;
		this.server.emitClient('client-disconnect', this, reason, err);
		this.dispose(String(reason));
	}

	// 广播给除了自己以外的所有客户端
	/**
	 * Broadcasts to all connected peers except this connection.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 */
	broadcastNotSelf(event: string, data: any): void {
		this.server.broadcast(event, data, (c) => c !== this);
	}

	private handleMessage(_raw: RawData): boolean {
		if (!this.isConnected()) return false;
		const data = raw2String(_raw);
		if (!data){
			this.logger.warn(this.logHead('handleMessage', 'warn'), 'Unknown raw type', typeof data);
			return false;
		}

		const parsed = this.parseMessage(data); //will check recvLen
		if (!parsed) return;
		if (this.prevHandle(parsed)) return; //ping pong 消息直接处理
		const limit = this.server.opts.messageRateLimit;
		if (limit && !this.limitTest(limit)) {
			return false;
		}

		if (this.observeLogger) {
			this.observeLogger.debug("[observe]", this.id, parsed.e, parsed.d);
		}

		const handler = this.handlers.get(parsed.e);
		if (handler) {
			handler(parsed.d);
			return true;
		}
		else {
			return this.server.handleClientMsg(this, parsed.e, parsed.d);
		}
	}

	private limitTest(limit: MessageRateLimit): boolean {
		const now = performance.now();
		this.messageTokens = Math.min(limit.burst,
			this.messageTokens + (now - this.lastMessageTime) * limit.perSecond / 1000);
		this.lastMessageTime = now;
		if (this.messageTokens < 1) {
			this.server.kickoff(this.id, 'message rate limit');
			return false;
		}
		this.messageTokens--;	    
		return true;
	}

	/**
	 * Returns the outgoing JSON string-length limit in UTF-16 code units.
	 */
	override maxSendLen(): number {
		return this.server.opts.maxSendLen;
	}

	/**
	 * Returns the incoming JSON string-length limit in UTF-16 code units.
	 */
	override maxRecvLen(): number {
		return this.server.opts.maxRecvLen;
	}

	/**
	 * Immediately terminates the Node.js transport without a closing handshake.
	 */
	terminate(){
		this.ws.terminate();
	}

    /**
     * Optional logger for incoming business-message observation.
     */
    observeLogger?: LiteLogger;
	// 暂时用console代替
	/**
	 * Attaches incoming-message diagnostics; server lookup returns whether the connection exists.
	 */
	observe(log:LiteLogger) {
		this.observeLogger = log;
	}
}
