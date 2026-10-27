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


export class LiteServerClient extends LiteSocket implements CommonSocket{
	id: number;
	readonly server: LiteServer;
	readonly remoteAddress: string;
	private handlers = new Map<string | symbol, (data?: any) => void>();
	private disposed = false;
	private messageTokens = 0;
	private lastMessageTime = performance.now();

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

	override isConnected(): boolean {
		return !this.disconnected && !this.disposed && super.isConnected();
	}

	get connected(): boolean {
		return this.isConnected();
	}

	on(event: string | symbol, handler: (data?: any) => void): this {
		if (this.handlers.has(event)) {
			this.logger.warn(this.logHead('on', 'warn'), event, 'already registered');
		}
		this.handlers.set(event, handler);
		return this;
	}

	join(room: string): void {
		if (this.isConnected()) this.server.joinRoom(room, this);
	}

	leave(room: string): void {
		this.server.leaveRoom(room, this);
	}

	dispose(reason?: string): boolean {
		if (this.disposed) return false;
		this.disposed = true;
		this.handlers.clear();
		return true;
	}

	//不是消息是事件
	emitEvent(eventName: clientEvent, reason?: string | number, err?: any){
		this.server.emitClient(eventName, this, reason, err);
	}

	private disconnected = false;
	// 确保仅仅一次
	emitDisconnect(reason: DisconnectReason, err?: any) {
		if (this.disconnected) return;
		this.disconnected = true;
		this.server.emitClient('client-disconnect', this, reason, err);
		this.dispose(String(reason));
	}

	// 广播给除了自己以外的所有客户端
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
			this.observeLogger.debug("[observe]", this.id, parsed.eventName, parsed.data);
		}

		const handler = this.handlers.get(parsed.eventName);
		if (handler) {
			handler(parsed.data);
			return true;
		}
		else {
			return this.server.handleClientMsg(this, parsed.eventName, parsed.data);
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

	override maxSendLen(): number {
		return this.server.opts.maxSendLen;
	}

	override maxRecvLen(): number {
		return this.server.opts.maxRecvLen;
	}

	terminate(){
		this.ws.terminate();
	}

    observeLogger?: LiteLogger;
	// 暂时用console代替
	observe(log:LiteLogger) {
		this.observeLogger = log;
	}
}
