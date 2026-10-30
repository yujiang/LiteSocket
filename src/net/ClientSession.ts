/*
处理回调异步的回调
并且每10s检测一下callback，也避免内存泄露,
timeout无法统一处理，只能每个msg自带timeout！
*/

import { SessionCallback, onTimeoutFunc } from './SessionCallback';
import { getMsgName } from './msgid';
import { msgData, Utils } from '../public/Depends';
import { LiteLogger } from "../public/log";
import { ErrorEnum, FirstErrorRt, CallbackFirstError } from './ErrorEnum';

// rt 1 suc 0 fail
// export type packCallback = (rt: number) => void;

/**
 * Client RPC configuration, separate from transport options.
 */
export interface ClientParam {
	/**
	 * Application identifier returned by getId, independent of the server-assigned socket ID.
	 */
	connectionId?: number;
	/**
	 * Enables periodic RPC timeout checks; a request timeout alone does not enable polling.
	 * @defaultValue false
	 */
	checktimeout?: boolean; // 默认false
	/**
	 * RPC polling interval in milliseconds; nonpositive/nonfinite values use 1000.
	 * @defaultValue 1000
	 */
	checkIntervalMs?: number; // 默认1000
}

/**
 * Connection contract required by the client RPC registry.
 */
export interface ClientSessionSocket {
	connected?: boolean;
	/**
	 * Sends a framed event; false means disconnected or synchronous encoding/size/send failure. True does not acknowledge delivery.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param args - Unpacked arguments; variadic send APIs start with a message ID.
	 */
	emit(event: string, args: msgData): void;
}

const SESSION_MAX = 10*10000;

// 作为LiteClient的回调
/**
 * Client RPC registry; timeout checks must be scheduled explicitly.
 */
export class ClientSession extends SessionCallback {
	/**
	 * Creates ClientSession with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 * @param logger - Logger implementing LiteLogger; console is supported.
	 * @param func - Optional observer invoked when pending requests time out.
	 */
	constructor(name: string, logger: LiteLogger, func?: onTimeoutFunc) {
		super(name, logger, func);
		this.name = name;
	}

	/**
	 * Clears request storage and releases the socket reference; reset requests first to settle them.
	 */
	override close() {
		super.close()
		this.socket = null;
	}

	/**
	 * Current client transport; may be unset before connection setup or after cleanup.
	 */
	socket: ClientSessionSocket;

	/**
	 * Reports whether the RPC transport currently accepts requests.
	 */
	override isSessionConnect(): boolean {
		return this.socket?.connected;
	}

	/**
	 * Settles pending requests with Callback_bindsocket and binds a new transport.
	 */
	resetSocket(socket: ClientSessionSocket): void {
		this.reset(ErrorEnum.Callback_bindsocket, false);
		this.socket = socket;
	}

	/**
	 * Sends the mutable request through the bound client transport.
	 * @param mod - Wire event category.
	 * @param msg - Numeric message ID or mutable business tuple, as specified by the signature.
	 */
	override emitMsg(mod: string, msg: msgData): void {
		this.logger.debug('socket.emit', mod, getMsgName(msg[0]), msg);
		this.socket.emit(mod, msg);
	}

	/**
	 * Sends RPC through the specified category and appends the session to the supplied array.
	 * @param mod - Wire event category.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param timeout - Timeout in milliseconds; RPC zero uses timeoutMax and requires timeout polling.
	 * @returns Promise resolving to [error code, ...results].
	 */
	async asendMod(mod: string, data: msgData, timeout = 0): Promise<FirstErrorRt> {
		if (!this.socket || !this.socket.connected) {
			this.logger.warn('httpclient asendMod !socket.connected', this.name);
			return [ErrorEnum.Net_notconnect, null];
		}
		return this.asendSession(mod, data, timeout);
	}

	/**
	 * Sends client RPC through the specified category and resolves to its error code; mutates data.
	 * @param mod - Wire event category.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param timeout - Timeout in milliseconds; RPC zero uses timeoutMax and requires timeout polling.
	 */
	async asendModReturnError(mod: string, data: msgData, timeout = 0): Promise<ErrorEnum> {
		if (!this.socket || !this.socket.connected) {
			this.logger.warn('httpclient asendModReturnError !socket.connected', this.name);
			return ErrorEnum.Net_notconnect;
		}
		return this.asendSessionReturnError(mod, data, timeout);
	}

	// log = false;
	/**
	 * Sends through the specified category; client session sending appends a session/zero to the supplied array.
	 * @param mod - Wire event category.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param callback - Business handler or request completion callback.
	 * @param timeout - Timeout in milliseconds; RPC zero uses timeoutMax and requires timeout polling.
	 */
	sendMod(mod: string, data: msgData, timeout = 0, callback:CallbackFirstError = null): void {
		if (!this.socket || !this.socket.connected) {
			this.logger.warn('httpclient sendMod !socket.connected', this.name);
			if (callback) {
				callback([ErrorEnum.Net_notconnect, null]);
			}
			return;
		}
		this.sendSession(mod, data, timeout, callback);
	}

	/**
	 * Completes client RPC; returns false for an unknown session.
	 * @param id - Connection ID or RPC correlation number, as specified by this API.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 */
	onCallbacked(id: number, data: FirstErrorRt): boolean {
		const func = this.callbacks[id];
		if (!func) {
			this.logger.error(
				`httpclient.on_callbacked error id ${id} not found ${this.name} data ${data}`,
			);
			return false;
		}
		this.logger.debug('onCallbacked', id, data);
		this.onSessionCallback(id, data);
		return true;
	}

	/**
	 * Checks RPC timeouts and recycles the client session counter only when no requests remain.
	 */
	onCheck(): void {
		const num = this.checkTimeout(SessionCallback.getTime());
		if (num > 0) {
			this.logger.warn('checkTimeout num', num);
		}
		if (this.session > SESSION_MAX && Utils.lenObject(this.callbacks) === 0) {
			this.logger.warn('this.session > max reset to 1');
			this.session = 1;
		}
	}

	// 开始打包 -- 不实用,删除了~
	// packs: packData[] = [];

	// pack = false;

	// startPack() {
	// 	this.pack = true;
	// 	this.packs = [];
	// }

	// // 结束打包
	// async endPack(timeout: number): Promise<number> {
	// 	if (this.packs.length === 0) {
	// 		return 0;
	// 	}

	// 	this.pack = false;
	// 	const { packs } = this;
	// 	this.packs = [];
	// 	return this.asendSessionReturnError(NetEventEnum.eventPack, packs as msgData, timeout);
	// }
}
