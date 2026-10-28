// LiteSocket.s
// LiteClient和LiteServerClient的基类

import { WebSocket } from 'ws';
import {
	logHeadEx,
	msgJsonParseError,
	msgJsonStringError,
	msgInvalidPacket,
	msgRecvMax,
	msgSendMax,
	msgSendError,
	SocketCloseCode,
} from './LiteNet';
import { LiteLogger } from "../public/log";
import { NetEventEnum } from './msgid';
import { msgData } from '../client';

export type SocketReason = string | number;

export type SocketMsgType = {eventName: string, data: any};

export abstract class LiteSocket {
	name: string;
	logger: LiteLogger;

	constructor(name: string, logger: LiteLogger) {
		this.name = name;
		this.logger = logger;
	}

    static encodeMessage(eventName: string, data: any): string {
        return JSON.stringify({ eventName, data });    
    }
    static decodeMessage(data: string): SocketMsgType {
        return JSON.parse(data);
    }

    abstract emitEvent(eventName: string, reason?: string | number, err?: any): void;
    abstract maxSendLen(): number;
    abstract maxRecvLen(): number;

    getMaxSendLen() {
        return this.maxSendLen() ?? 1024 * 1024;
    }

    getMaxRecvLen() {
        return this.maxRecvLen() ?? 1024 * 1024;
    }

	ws: WebSocket;
	// 连接成功, 可以发消息了
	isConnected(): boolean {
		return this.getReadyState() === WebSocket.OPEN;
	}
	isConnecting(): boolean {
		return this.getReadyState() === WebSocket.CONNECTING;
	}

	getReadyState() {
		return this.ws?.readyState;
	}

	// for room
	wsSend(s: string) {
		this.ws?.send(s);
	}
	// 主动发起断线, 一般只用于调试
	disconnect(code: SocketCloseCode = SocketCloseCode.disconnect, reason?: string) {
		this.close(code, reason);
	}

	close(code = SocketCloseCode.normal, reason?: string): void {
		this.ws?.close(code, reason);
	}

	private delay: number;
	private delays: number[] = [];

	lastPong: number = Date.now();

	// 仅用于调试
	private _stopPong = false;
	stopPong(stop: boolean) {
		this._stopPong = stop;
	}

	onPong(data: [number, number]) {
        const [start, peer] = data;
        // peer 可以用来判定加速?
		const now = Date.now();
		this.delay = (now - start) / 2; //一来一回
		// 保持10个延迟值，取平均值
		if (this.delays.push(this.delay) > 10) {
			this.delays.shift();
		}
		this.lastPong = now;
	}

	onPing(time: number) {
		if (this._stopPong) return;
		if (this.isConnected()) {
			this.emit('pong', [time, Date.now()]);
		}
	}

	// return error str
	heartBreak(now: number, heartbeatTimeout: number) {
		if (now - this.lastPong > heartbeatTimeout) {
			// 心跳超时
			return 'pong-timeout';
		}
		if (this.isConnected()) {
			this.emit('ping', now);
		}
		return '';
	}

	// 获取delay平均值
	getArgDelay() {
        if (this.delays.length === 0) return 0;
		return this.delays.reduce((a, b) => a + b, 0) / this.delays.length;
	}

	parseMessage(data: string) : SocketMsgType|undefined {
        const maxRecvLen = this.getMaxRecvLen();
		if (data.length >= maxRecvLen) {
			this.logger.warn(
				this.logHead('parseMessage', 'warn'),
				msgRecvMax,
				data.length,
				'>=',
				maxRecvLen,
			);
			this.emitEvent('exception', msgRecvMax);
			return;
		}

		if (data.length === 0) {
			return;
		}

		let parsed: SocketMsgType;
		try {
			parsed = LiteSocket.decodeMessage(data);
		} catch (err) {
			this.logger.error(this.logHead('parseMessage', 'error'), 'JSON.parse error', data, err);
			this.emitEvent('exception', msgJsonParseError);
			return;
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
			typeof parsed.eventName !== 'string' || parsed.eventName.length === 0 || !this.isValidSystemMessage(parsed)) {
			this.emitEvent('exception', msgInvalidPacket);
			return;
		}
		return parsed;
	}

	private isValidSystemMessage(parsed: SocketMsgType): boolean {
		const data = parsed.data;
		switch (parsed.eventName) {
			case 'ping':
				return typeof data === 'number' && Number.isFinite(data) && data >= 0;
			case 'pong':
				return Array.isArray(data) && data.length === 2 &&
					data.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
			case 'system':
				return !!data && typeof data === 'object' && !Array.isArray(data) &&
					[data.id, data.maxSendLen, data.maxRecvLen].every(value => Number.isSafeInteger(value) && value > 0);
			default:
				return true;
		}
	}

	logHead(func: string, logtype?: string) {
		return logHeadEx(this.constructor.name, this.name, func, logtype);
	}

	sendMsg(...args: msgData) : boolean {
		// console.log(args);
		return this.emit(NetEventEnum.eventMod, args);
	}

	emit(event: string, data?: any): boolean {
		if (!this.isConnected()) {
			this.logger.warn(this.logHead('emit', 'warn'), 'not open', event, data);
			return false;
		}
		let msg: string;
		try {
			msg = LiteSocket.encodeMessage(event, data);
		} catch (err) {
			this.logger.error(this.logHead('emit', 'error'), 'error:', err instanceof Error ? err.message : String(err));
			this.emitEvent('exception', msgJsonStringError, { eventName: event, data, error: err });
			return false;
		}
		const maxSendLen = this.getMaxSendLen();
		if (msg.length >= maxSendLen) {
			this.logger.error(this.logHead('emit', 'error'), msgSendMax, msg.length, '>=', maxSendLen);
			this.emitEvent('exception', msgSendMax, { eventName: event, data });
			return false;
		}
		try {
			this.ws.send(msg);
		} catch (err) {
			this.logger.error(this.logHead('emit', 'error'), 'error:', err instanceof Error ? err.message : String(err));
			this.emitEvent('exception', msgSendError, { eventName: event, data, error: err });
			return false;
		}
		return true;
	}

	prevHandle(parsed: SocketMsgType) {
		switch (parsed.eventName) {
			case 'pong':
				this.onPong(parsed.data);
				break;
			case 'ping':
				this.onPing(parsed.data);
				break;
			default:
				return false;
		}
		return true;
	}
}
