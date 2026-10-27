import { strict as assert } from 'assert';
import { LiteLogger } from "../public/log";
import { tryCall } from '../public/call';
import { msgData } from '../public/Depends';
import { CallbackFirstError, ErrorEnum, FirstErrorRt } from './ErrorEnum';

export type CallbackData = [string, msgData, CallbackFirstError, number, number];
export type onTimeoutFunc = (msgid: number, data: CallbackData, timeout: number) => void;

export abstract class SessionCallback {
	name: string;
	logger: LiteLogger;

	func: onTimeoutFunc;

	private onTimeout(data: CallbackData, timeout: number) {
		this.func?.(data[1][0], data, timeout);
	}

	constructor(name: string, logger: LiteLogger, func?: onTimeoutFunc) {
		this.name = name;
		this.logger = logger;
		this.func = func;
	}

	close() {
		this.func = null;
		this.callbacks = {};
	}

	session = 1;

	// [mod msg callback timesend timeout]
	callbacks: { [key: number]: CallbackData } = {};

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

	static getTime(): number {
		return Date.now();
	}

	// 用这个函数来简化一些写法
	asendSessionReturnError(mod: string, data: msgData, timeout: number): Promise<ErrorEnum> {
		return new Promise((resolve) => {
			this.sendSession(mod, data, timeout, (rt: FirstErrorRt) => {
				resolve(Array.isArray(rt) ? rt[0] : rt);
			});
		});
	}

	// timeout: 毫秒
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
		this.sendMsg(mod, msg);
	}

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

	abstract isSessionConnect(): boolean;

	abstract sendMsg(mod: string, msg: msgData): void;

	// 服务器的player重连时重发所有的session!, 不要做,容易引发额外错误.
	// onReconnect(): void {
	// 	for (const cb of Object.values(this.callbacks)) {
	// 		this.sendMsg(cb[0], cb[1]);
	// 	}
	// }

	checkTimeout(now: number): number {
		let num = 0;
		for (const [id, data] of Object.entries(this.callbacks)) {
			// 4 timeout 3 timesend
			if (data[4] > 0 && now - data[3] > data[4]) {
				this.onTimeout(data, data[4]);
				this.onSessionCallback(Number(id), [ErrorEnum.Callback_timeout]);
				num++;
			}
		}
		return num;
	}
}
