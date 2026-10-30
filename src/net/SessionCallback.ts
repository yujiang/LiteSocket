import { strict as assert } from 'assert';
import { LiteLogger } from "../public/log";
import { tryCall } from '../public/call';
import { msgData } from '../public/Depends';
import { CallbackFirstError, ErrorEnum, FirstErrorRt } from './ErrorEnum';
import { W10 } from './msg';
import { SendExceptionDetails } from './LiteNet';
import { SocketReason } from './LiteSocket';

/**
 * Pending request tuple: event, mutable request, resolver, send timestamp, timeout in milliseconds.
 */
export type CallbackData = [string, msgData, CallbackFirstError, number, number];
/**
 * Timeout observer receiving message ID, pending request, and timeout in milliseconds.
 */
export type onTimeoutFunc = (msgid: number, data: CallbackData, timeout: number) => void;


// 作为LiteServerClient的callback回调
/**
 * Matches RPC responses to pending requests and settles checked timeouts and transport failures.
 */
export abstract class SessionCallback {
	/**
	 * Human-readable diagnostic label.
	 */
	name: string;
	/**
	 * Injected diagnostic logger; console implements the required contract.
	 */
	logger: LiteLogger;
	/**
	 * Default RPC timeout in milliseconds for requests specifying zero; requires timeout checks.
	 * @defaultValue 100000
	 */
	timeoutMax = W10;

	func: onTimeoutFunc;

	private onTimeout(data: CallbackData, timeout: number) {
		this.func?.(data[1][0], data, timeout);
	}

	/**
	 * Creates SessionCallback with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 * @param logger - Logger implementing LiteLogger; console is supported.
	 * @param func - Optional observer invoked when pending requests time out.
	 */
	constructor(name: string, logger: LiteLogger, func?: onTimeoutFunc) {
		this.name = name;
		this.logger = logger;
		this.func = func;
	}

	/**
	 * Clears the request registry without settlement; call reset with a nonzero error first to complete pending requests.
	 */
	close() {
		this.func = null;
		this.callbacks = {};
	}

	/**
	 * Next RPC correlation number; unrelated to user authentication.
	 */
	session = 1;

	// [mod msg callback timesend timeout]
	/**
	 * Pending RPCs keyed by session, removed on response, checked timeout, or reset.
	 */
	callbacks: { [key: number]: CallbackData } = {};

	/**
	 * Clears requests and resets numbering; nonzero error settles requests, while zero clears them without settlement.
	 * @param callback - Error code used to settle pending requests; zero skips settlement.
	 * @param msg - Whether to notify the timeout observer for every cleared request.
	 * @param why - Diagnostic reason for releasing the client.
	 */
	reset(callback: ErrorEnum, msg: boolean, why?: string): void {
		this.session = 1;
		const cbs = this.callbacks;
		this.callbacks = {};
		// 一般都是true, 否则会有内存泄漏!
		if (!callback) return;
		for (const cb of Object.values(cbs)) {
			if (msg) {
				this.onTimeout(cb, 0);
			}
			tryCall(cb[2], [callback, why]);
		}		
	}

	/**
	 * Returns the wall-clock timestamp in milliseconds used by timeout checks.
	 */
	static getTime(): number {
		return Date.now();
	}

	// 用这个函数来简化一些写法
	/**
	 * Sends RPC and resolves to its error code only; mutates the supplied array.
	 * @param mod - Wire event category.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param timeout - Timeout in milliseconds; RPC zero uses timeoutMax and requires timeout polling.
	 */
	asendSessionReturnError(mod: string, data: msgData, timeout: number): Promise<ErrorEnum> {
		return new Promise((resolve) => {
			this.sendSession(mod, data, timeout, (rt: FirstErrorRt) => {
				resolve(Array.isArray(rt) ? rt[0] : rt);
			});
		});
	}

	// timeout: 毫秒
	/**
	 * Registers and sends RPC; appends the session to data and resolves with the response tuple.
	 * @param mod - Wire event category.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param timeout - Timeout in milliseconds; RPC zero uses timeoutMax and requires timeout polling.
	 */
	asendSession(mod: string, data: msgData, timeout: number): Promise<FirstErrorRt> {
		return new Promise((resolve) => {
			this.sendSession(mod, data, timeout, (rt: FirstErrorRt) => {
				// 因为是网络层，所以不进行任何解析才对！
				resolve(rt);
			});
		});
	}

	sended = 0;

	callbacked = 0;

	// timeout: 毫秒
	/**
	 * Appends a session (zero without a callback), registers completion, and sends the mutable request.
	 * @param mod - Wire event category.
	 * @param msg - Numeric message ID or mutable business tuple, as specified by the signature.
	 * @param timeout - Timeout in milliseconds; RPC zero uses timeoutMax and requires timeout polling.
	 * @param callback - Business handler or request completion callback.
	 */
	sendSession(mod: string, msg: msgData, timeout: number, callback?: CallbackFirstError): void {
		if (!this.isSessionConnect()) {
			callback?.([ErrorEnum.Net_notconnect, null]);
			return;
		}

		this.sended++;

		if (callback) {
			// session把id放在尾部！
			msg.push(this.session);
			this.callbacks[this.session] = [mod, msg, callback, SessionCallback.getTime(), timeout];
			this.session++;
		} else {
			msg.push(0);
		}
		this.emitMsg(mod, msg);
	}

	/**
	 * Removes and completes a pending request by session; unknown sessions are logged.
	 * @param id - Connection ID or RPC correlation number, as specified by this API.
	 */
	onSessionCallback(id: number, rt: FirstErrorRt): void {
		assert(typeof id === 'number');
		const cb = this.callbacks[id];
		if (cb) {
			this.callbacked++;
			delete this.callbacks[id];
			// cb[2](rt);
			tryCall(cb[2], rt);
		} else {
			this.logger.error(`${this.name}.onSessionCallback not find id`, id);
		}
	}

	/**
	 * Reports whether the RPC transport currently accepts requests.
	 */
	abstract isSessionConnect(): boolean;

	/**
	 * Sends the mutable request through the subclass transport implementation.
	 * @param mod - Wire event category.
	 * @param msg - Numeric message ID or mutable business tuple, as specified by the signature.
	 */
	abstract emitMsg(mod: string, msg: msgData): void;

	// 服务器的player重连时重发所有的session!, 不要做,容易引发额外错误.
	// onReconnect(): void {
	// 	for (const cb of Object.values(this.callbacks)) {
	// 		this.sendMsg(cb[0], cb[1]);
	// 	}
	// }

	/**
	 * Settles expired requests using a wall-clock millisecond timestamp; returns the number expired.
	 * @param now - Wall-clock timestamp in milliseconds, usually Date.now().
	 * @returns Number of requests expired during this check.
	 */
	checkTimeout(now: number): number {
		let num = 0;
		for (const [id, data] of Object.entries(this.callbacks)) {
			// 4 timeout 3 timesend
			const timeout = data[4] || this.timeoutMax; // 默认 100 秒；timeoutMax 的单位为毫秒
			if (now - data[3] > timeout) {
				this.onTimeout(data, timeout);
				this.onSessionCallback(Number(id), [ErrorEnum.Callback_timeout]);
				num++;
			}
		}
		return num;
	}

	/**
	 * Settles RPC when diagnostic event category, request reference, and trailing session match.
	 * @param reason - Diagnostic or close reason.
	 */
	onSendFailed(reason: SocketReason, details: SendExceptionDetails){
		const id = details.data[details.data.length - 1];
		if (!Number.isSafeInteger(id) || id <= 0) return;
		const pending = this.callbacks[id];
		if (pending?.[0] === details.eventName && pending[1] === details.data) {
			this.onSessionCallback(id, [ErrorEnum.settleSendFailure, String(reason)]);
		}
	}
}
