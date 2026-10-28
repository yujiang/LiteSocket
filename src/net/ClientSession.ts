/*
处理回调异步的回调
并且每10s检测一下callback，也避免内存泄露,
timeout无法统一处理，只能每个msg自带timeout！
*/

import { SessionCallback, onTimeoutFunc } from './SessionCallback';
import { getMsgName, NetEventEnum } from './msgid';
import { msgData, packData, Utils } from '../public/Depends';
import { LiteLogger } from "../public/log";
import { ErrorEnum, FirstErrorRt, CallbackFirstError } from './ErrorEnum';

// rt 1 suc 0 fail
export type packCallback = (rt: number) => void;

export interface ClientParam {
	connectionId?: number;
	checktimeout?: boolean; // 默认false
	checkIntervalMs?: number; // 默认1000
}

export type onCircleFunc = (mod: string, msg: msgData) => void;

export interface NetCallbackSocket {
	connected?: boolean;
	emit(event: string, args: msgData): void;
}

const SESSION_MAX = 10*10000;

// 作为LiteClient的回调
export class ClientSession extends SessionCallback {
	constructor(name: string, logger: LiteLogger, func?: onTimeoutFunc) {
		super(name, logger, func);
		this.name = name;
	}

	override close() {
		super.close()
		this.socket = null;
	}

	// 发送的对象, 有循环引用导致无法json.stringfy
	// funcCircle: onCircleFunc;
	// checkCircle(func: onCircleFunc) {
	// 	this.funcCircle = func;
	// }

	socket: NetCallbackSocket;

	override isSessionConnect(): boolean {
		return this.socket?.connected;
	}

	resetSocket(socket: NetCallbackSocket): void {
		this.reset(ErrorEnum.Callback_bindsocket, false);
		this.socket = socket;
	}

	override emitMsg(mod: string, msg: msgData): void {
		// this.logger.debug('sendMsg', mod, MsgId[msg[0]], msg);
		// if (this.funcCircle && Utils.isCircle(msg)) {
		// 	this.logger.error('sendMsg circle', mod, MsgId[msg[0]], msg);
		// 	this.funcCircle(mod, msg);
		// 	return;
		// }
		this.logger.debug('socket.emit', mod, getMsgName(msg[0]), msg);
		this.socket.emit(mod, msg);
	}

	async asendMod(mod: string, data: msgData, timeout = 0): Promise<FirstErrorRt> {
		if (!this.socket || !this.socket.connected) {
			this.logger.warn('httpclient asendMod !socket.connected', this.name);
			return [ErrorEnum.Net_notconnect, null];
		}
		return this.asendSession(mod, data, timeout);
	}

	async asendModReturnError(mod: string, data: msgData, timeout = 0): Promise<ErrorEnum> {
		if (!this.socket || !this.socket.connected) {
			this.logger.warn('httpclient asendModReturnError !socket.connected', this.name);
			return ErrorEnum.Net_notconnect;
		}
		return this.asendSessionReturnError(mod, data, timeout);
	}

	// log = false;
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
