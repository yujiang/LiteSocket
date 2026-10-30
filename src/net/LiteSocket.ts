// LiteSocket.s LiteClient和LiteServerClient的基类

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

/**
 * Lifecycle reason string or numeric diagnostic value such as retry count.
 */
export type SocketReason = string | number;

/**
 * Decoded JSON wire packet: event category e and payload d.
 */
export type SocketMsgType = {e: string, d: any};

//LiteServerClient , LiteClient的基类
/**
 * Shared WebSocket framing, validation, string-length limits, and application heartbeats.
 */
export abstract class LiteSocket {
	/**
	 * Human-readable diagnostic label.
	 */
	name: string;
	/**
	 * Injected diagnostic logger; console implements the required contract.
	 */
	logger: LiteLogger;

	/**
	 * Creates LiteSocket with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 * @param logger - Logger implementing LiteLogger; console is supported.
	 */
	constructor(name: string, logger: LiteLogger) {
		this.name = name;
		this.logger = logger;
	}

    /**
     * Serializes an event and payload as JSON using wire fields e and d.
     * @param eventName - Transport category or lifecycle name.
     * @param data - Payload; session sending and business dispatch may modify the array in place.
     */
    static encodeMessage(eventName: string, data: any): string {
        return JSON.stringify({ e:eventName, d: data });    
    }
    /**
     * Parses JSON without protocol validation; malformed JSON throws. Use parseMessage for validation.
     * @param data - Payload; session sending and business dispatch may modify the array in place.
     */
    static decodeMessage(data: string): SocketMsgType {
        return JSON.parse(data);
    }

    /**
     * Dispatches a lifecycle or diagnostic event to observers.
     * @param eventName - Transport category or lifecycle name.
     * @param reason - Diagnostic or close reason.
     */
    abstract emitEvent(eventName: string, reason?: string | number, err?: any): void;
    /**
     * Returns the outgoing JSON string-length limit in UTF-16 code units.
     */
    abstract maxSendLen(): number;
    /**
     * Returns the incoming JSON string-length limit in UTF-16 code units.
     */
    abstract maxRecvLen(): number;

    /**
     * Returns the outgoing string-length limit, falling back to 1048576.
     */
    getMaxSendLen() {
        return this.maxSendLen() ?? 1024 * 1024;
    }

    /**
     * Returns the incoming string-length limit, falling back to 1048576.
     */
    getMaxRecvLen() {
        return this.maxRecvLen() ?? 1024 * 1024;
    }

	/**
	 * Underlying WebSocket transport; may be unset before a client connection attempt.
	 */
	ws: WebSocket;
	// 连接成功, 可以发消息了
	/**
	 * Reports whether this connection is usable; clients additionally require the system handshake.
	 */
	isConnected(): boolean {
		return this.getReadyState() === WebSocket.OPEN;
	}
	/**
	 * Reports whether a connection attempt is still awaiting readiness.
	 */
	isConnecting(): boolean {
		return this.getReadyState() === WebSocket.CONNECTING;
	}

	/**
	 * Returns the underlying WebSocket state, or undefined before socket creation.
	 */
	getReadyState() {
		return this.ws?.readyState;
	}

	// for room
	/**
	 * Sends an encoded string directly, bypassing framing and size checks; may throw.
	 */
	wsSend(s: string) {
		this.ws?.send(s);
	}

	/**
	 * Requests a closing handshake with an application close code.
	 * @param code - Application WebSocket close code.
	 * @param reason - Diagnostic or close reason.
	 */
	disconnect(code: SocketCloseCode = SocketCloseCode.disconnect, reason?: string) {
		this.close(code, reason);
	}

	/**
	 * Requests a closing handshake; reason must fit the WebSocket 123-byte UTF-8 limit.
	 * @param reason - Diagnostic or close reason.
	 * @param code - Application WebSocket close code.
	 */
	close(code = SocketCloseCode.normal, reason?: string): void {
		this.ws?.close(code, reason);
	}

	private delay: number;
	private delays: number[] = [];

	/**
	 * Monotonic timestamp of the latest accepted pong, in milliseconds.
	 */
	lastPong: number = performance.now();

	// 仅用于调试
	private _stopPong = false;
	/**
	 * Enables or disables pong replies for heartbeat diagnostics.
	 */
	stopPong(stop: boolean) {
		this._stopPong = stop;
	}

	/**
	 * Records pong receipt and estimates one-way delay as half the round-trip duration.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 */
	onPong(data: [number, number]) {
        const [start, peer] = data;
        // start is echoed from this endpoint; peer uses its own clock origin and is not compared.
		const now = performance.now();
		this.delay = (now - start) / 2; //一来一回
		// 保持10个延迟值，取平均值
		if (this.delays.push(this.delay) > 10) {
			this.delays.shift();
		}
		this.lastPong = now;
	}

	/**
	 * Replies to an application ping unless pong replies are disabled.
	 */
	onPing(time: number) {
		if (this._stopPong) return;
		if (this.isConnected()) {
			this.emit('pong', [time, performance.now()]);
		}
	}

	// return error str
	/**
	 * Checks pong age and sends a ping; returns pong-timeout when expired, otherwise an empty string.
	 * @param now - Monotonic timestamp in milliseconds, usually performance.now().
	 * @param heartbeatTimeout - Maximum accepted pong age in milliseconds.
	 */
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
	/**
	 * Returns mean estimated one-way delay over the last ten pongs, in milliseconds; zero before any pong.
	 */
	getArgDelay() {
        if (this.delays.length === 0) return 0;
		return this.delays.reduce((a, b) => a + b, 0) / this.delays.length;
	}

	/**
	 * Checks size, JSON syntax, and protocol shape; invalid input emits an exception and returns undefined.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 */
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
			this.logger.error(this.logHead('parseMessage', 'error'), 
				'LiteSocket.decodeMessage JSON.parse data:', data, "err:\n", err);
			this.emitEvent('exception', msgJsonParseError);
			return;
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
			typeof parsed.e !== 'string' || parsed.e.length === 0 || !this.isValidMessage(parsed)) {
			this.emitEvent('exception', msgInvalidPacket);
			return;
		}
		return parsed;
	}

	private isValidMessage(parsed: SocketMsgType): boolean {
		const data = parsed.d;
		switch (parsed.e) {
			case 'ping':
				return typeof data === 'number' && Number.isFinite(data) && data >= 0;
			case 'pong':
				return Array.isArray(data) && data.length === 2 &&
					data.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
			case 'system':
				return !!data && typeof data === 'object' && !Array.isArray(data) &&
					[data.id, data.maxSendLen, data.maxRecvLen].every(value => Number.isSafeInteger(value) && value > 0);
			case NetEventEnum.eventCallbacked:
				return Array.isArray(data) && data.length === 2 && Number.isSafeInteger(data[0]) && data[0] >= 0 &&
					Array.isArray(data[1]) && Number.isSafeInteger(data[1][0]) && data[1][0] >= 0;
			case NetEventEnum.eventCallback:
			case NetEventEnum.eventGateCallback:
				return this.isValidMessageArray(data) && data.length >= 2 &&
					Number.isSafeInteger(data[data.length - 1]) && data[data.length - 1] >= 0;
			case NetEventEnum.eventMod:
			case NetEventEnum.eventBc:
			case NetEventEnum.eventGate:
			case NetEventEnum.eventGateMod:
				return this.isValidMessageArray(data);
			default:
				return true;
		}
	}

	private isValidMessageArray(data: unknown): data is msgData {
		return Array.isArray(data) && Number.isSafeInteger(data[0]) && data[0] > 0;
	}

	logHead(func: string, logtype?: string) {
		return logHeadEx(this.constructor.name, this.name, func, logtype);
	}

	/**
	 * Sends a numeric business message through the event transport.
	 * @param args - Unpacked arguments; variadic send APIs start with a message ID.
	 */
	emitMsg(...args: msgData) : boolean {
		// console.log(args);
		return this.emit(NetEventEnum.eventMod, args);
	}

	/**
	 * Sends a framed event; false means disconnected or synchronous encoding/size/send failure. True does not acknowledge delivery.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 */
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

	/**
	 * Consumes protocol control messages before business dispatch; returns whether the packet was handled.
	 */
	prevHandle(parsed: SocketMsgType) {
		switch (parsed.e) {
			case 'pong':
				this.onPong(parsed.d);
				break;
			case 'ping':
				this.onPing(parsed.d);
				break;
			default:
				return false;
		}
		return true;
	}
}
