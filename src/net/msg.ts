/*
管理消息：消息结构为一个array，
第一位为id:number,来自msgid.ts（之前第一位为string，虽然灵活但是效率低了）
typehandle是针对类别的handle，包括
typehandle包括一系列的msghandle,msghandle是针对消息的handle
*/
import { strict as assert } from 'assert';
import { CostGuard, CostGuards } from '../public/profile';
import { getMsgName, NetEventEnum } from './msgid';
import type { SessionCallback } from './SessionCallback';
import type { LiteLogger } from "../public/log";
import type { EventCallbackFunc, EventMods } from '../public/Depends';
import { msgData, SimpleObj, Utils } from '../public/Depends';
import { ErrorEnum } from './ErrorEnum';

export enum SocketParamEnum {
	noSocket, // 不带socket参数，一般用于客户端
	rawSocket, // 带socket参数，一般用于服务器进入游戏之前, login使用
	msgID,
	noClientId, // 移除第一个参数id,
	selfSocket, // 用self替代socket
}

export interface HttpSocketHandle {
	//$socketClientId?: number;
	emit(event: string, args: msgData): void;
}

export const W10 = 100000; //十万

// HttpSocket extends sio.Socket
export interface HttpSocket extends HttpSocketHandle {
	connected?: boolean;

	session?: SessionCallback; // 调试直连使用

	logger?: LiteLogger; 

	// 调试好用, 每个单独链接可以设定log, 比如把某个玩家发送的消息都记录下来!
	observeLogger?: LiteLogger; 

	on(event: string | symbol, listener: (...args: any[]) => void): this;
}

export type MsgFilterFunc = (socket: HttpSocketHandle, msgid: number, data: any[]) => any[];

// 对handle的参数装箱
export class MsgGuard extends CostGuard {
	constructor(
		name: string,
		guards: CostGuards,
		func: EventCallbackFunc,
		self: unknown,
		param: SocketParamEnum | MsgFilterFunc,
	) {
		super(name, guards);
		this.reset(func, self);
		this.setParam(param);
	}

	setParam(param: SocketParamEnum | MsgFilterFunc): void {
		this.filter = null;
		this.socketParam = SocketParamEnum.noSocket;
		if (param != null) {
			if (typeof param === 'function') {
				this.filter = param;
			} else {
				this.socketParam = param;
			}
		}
	}

	private self: unknown;

	private func: EventCallbackFunc;

	objname: string;

	reset(call: EventCallbackFunc, self: unknown, objname?: string): boolean {
		// self may be undefined and null
		if (this.func === call && this.self == self) {
			return false;
		}
		this.func = call;
		this.self = self;
		this.objname = objname;
		return true;
	}

	private filter: MsgFilterFunc; // 使用函数来获得参数，比如获得player作为首参数！

	socketParam: SocketParamEnum = SocketParamEnum.noSocket;

	close: boolean;

	closeMsg(close: boolean) {
		this.close = close;
	}

	trySocket(socket: HttpSocketHandle, msgid: number, data: any[]): unknown {
		if (this.close) {
			return ErrorEnum.Msg_closed;
		}
		let filterData = data;
		if (this.filter) {
			filterData = this.filter(socket, msgid, data);
			if (!filterData) {
				// console.error('Callback_filter_null', msgid, data, this.filter);
				return ErrorEnum.Callback_filter_null;
			}
		} else if (this.socketParam === SocketParamEnum.rawSocket) {
			// game.mod_gate and centerserver use it
			filterData.unshift(socket);
		} else if (this.socketParam === SocketParamEnum.msgID) {
			// only ClientAOI use it
			filterData.unshift(msgid);
		} else if (this.socketParam === SocketParamEnum.noClientId) {
			filterData.shift();
		} else if (this.socketParam === SocketParamEnum.selfSocket) {
			filterData.unshift(this.self);
			return this.func.apply(null, filterData);
		}
		// socke不必profile和try catch,没有必要,无非就是不打印错误!
		return this.tryCall(this.func, this.self, filterData);
		// return this.func.apply(this.self, filterData);
	}
}

export class MsgGuards extends CostGuards {
	override guards: { [key: string]: MsgGuard } = {};

	constructor(name: string, private readonly logger: LiteLogger) {
		super(name);
	}

	findMsgguard(
		tag: string,
		name: string,
		func: EventCallbackFunc,
		self: unknown,
		param: SocketParamEnum | MsgFilterFunc,
		// wait: boolean,
		objname?: string,
	): MsgGuard {
		let guard: MsgGuard = this.guards[name];
		if (!guard) {
			guard = new MsgGuard(name, this, func, self, param);
			guard.objname = objname;
			this.guards[name] = guard;
		} else {
			const old = guard.objname;
			const b = guard.reset(func, self, objname);
			//const msgname = MsgId[name];
			if (b) {
				this.logger.warn(tag, 'MsgHandle replaced', name, old, objname);
			}
			else if (old !== objname) {
				this.logger.warn(tag, 'MsgHandle objname changed', name, old, objname);
			}
			else {
				this.logger.warn(tag, 'MsgHandle dup', name, old);
			}
			guard.setParam(param);
		}
		return guard;
	}

	getMsgguard(name: string): MsgGuard {
		return this.guards[name] as MsgGuard;
	}

	closeMsg(msgid: number, close: boolean) {
		const guard = this.guards[msgid];
		guard?.closeMsg(close);
	}
}

export function getPlayerIdObj(obj: unknown) {
	if (obj == null) return 0;
	return typeof obj === 'object' ? obj['id'] || 0 : 0;
}

// raw func 在data[0]
// playerobj func 在data[1]
export function getPlayerId(data: msgData) {
	return getPlayerIdObj(data[0]) || getPlayerIdObj(data[1]);
}

export class MsgHandle {
	logger: LiteLogger;

	constructor(name: string, log: LiteLogger) {
		this.name = name;
		this.logger = log;
		this.handles = new MsgGuards('msgGuards', this.logger);
	}

	closeMsg(msgid: number, close: boolean) {
		this.handles.closeMsg(msgid, close);
	}

	name: string;

	handles: MsgGuards;

	getHandle(key: number): MsgGuard {
		return this.handles.getMsgguard(String(key));
	}

	setProfile(profile: boolean, printns = 10): void {
		this.handles.setProfile(profile, printns);
	}

	register(
		func: number,
		callback: EventCallbackFunc,
		self: unknown,
		param: SocketParamEnum | MsgFilterFunc,
		// wait?: boolean,
		objname: string,
	): MsgGuard {
		assert(func > 0);
		if (typeof callback !== 'function') {
			this.logger.error("error:register not a function", String(func), typeof callback);
			return null;
		}
		assert(typeof callback === 'function');
		return this.handles.findMsgguard(this.name, String(func), callback, self, param, objname);
	}

	registers(data: EventMods, self: unknown, param: SocketParamEnum | MsgFilterFunc, objname: string): void {
		// console.log('registers', data);
		for (const [key, func] of Object.entries(data)) {
			// assert(MsgId[key]);
			this.register(Number(key), func, self, param, objname);
		}
	}

	handledNum = 0;

	recvSockect = 0;

	handleMsg(socket: HttpSocketHandle, data: msgData, warning = true): boolean | Promise<boolean> {
		this.recvSockect++;
		if (this.recvSockect % W10 === 0) {
			this.logger.warn(`${this.name} recv ${this.recvSockect}`);
		}
		this.logger.debug('handleMsg', getMsgName(data[0]), data);

		const key = data[0];
		const msgfunc: MsgGuard = this.getHandle(key);
		if (msgfunc) {
			this.handledNum++;
			data.shift();
			msgfunc.trySocket(socket, key, data);
			return true;
		}
		if (warning) {
			this.logger.error(
				`${this.name} msg.handle not find func ${data[0]} ${getMsgName(data[0])}  data: `,
				data,
			);
			// this.logger.error('handles.keys:', Object.keys(this.handles.guards));
			// this.trace();
		}
		return false;
	}

	// return will set to rt.data
	// 仅仅是编辑器使用，不通过session，但是有返回值作为asend的返回！
	// 最好还是改造的一模一样较好！
	handleMsgRt(
		socket: HttpSocketHandle,
		data: msgData,
		rt: SimpleObj,
		warning = true,
	): boolean | Promise<boolean> {
		return this.handleMsg(socket, data, warning);
	}

	trace(top = 10, s = 0, per = false, logfunc = console.warn): void {
		console.log('MsgHandle.trace', this.name, 'len', Utils.objectLen(this.handles));
		this.handles.trace(top, s, per, logfunc);
	}
}

function isPromise(promise:any) {
	return !!promise && typeof promise.then === 'function';
}

export async function logPromise(rt: any) {
	const rt2 = await rt;
	console.log(rt2);
}

export class MsgHandleCB extends MsgHandle {
	override handleMsg(socket: HttpSocketHandle, data: msgData, warning = true): Promise<boolean> {
		return this.handleCallback(socket, data, null, warning);
	}

	// 为了editor做的, 因为没法把返回值emit回去了!
	override handleMsgRt(
		socket: HttpSocketHandle,
		data: msgData,
		rt: SimpleObj,
		warning = true,
	): Promise<boolean> {
		return this.handleCallback(socket, data, rt, warning);
	}

	cbSockect = 0;

	// see HttpClient.send
	async handleCallback(
		socket: HttpSocketHandle,
		data: msgData,
		returndata: SimpleObj = null,
		warning = true,
	): Promise<boolean> {
		this.cbSockect++;
		if (this.cbSockect % W10 === 0) {
			this.logger.warn(`${this.name} cb ${this.cbSockect}`);
		}
		this.logger.debug('handleCallback', data);

		const key = data[0];
		// session在末尾
		const session = data[data.length - 1];
		const msgfunc: MsgGuard = this.getHandle(key);
		if (!msgfunc) {
			if (warning) {
				this.logger.error(
					`${this.name} msg.handleCallback not find func ${data[0]} ${
						getMsgName(data[0])
					}  data: ${data}`,
				);
				// this.trace();
			}
			// const session = data[data.length - 1];
			socket.emit(NetEventEnum.eventCallbacked, [session, [ErrorEnum.Handle_not_find, null]]);
			return false;
		}

		data.shift();
		let rt = msgfunc.trySocket(socket, key, data);
		if (isPromise(rt)) {
			const time = Date.now();
			try {
				rt = await rt;
				const timeout = Date.now() - time;
				if (timeout > 1000) {
					this.logger.warn('handle_await timeout', key, getMsgName(key), 'cost', timeout);
					// 不敢随意stringfy(data),
					// 1. 如果是saveData这样的消息, 就太大了,
					// 2. data里有player指针
				}
			} catch (err) {
				this.logger.error(`handle_await exception`, key, getMsgName(key), err, data, getPlayerId(data));
				// logExceptionArgs(`msg_await ${key}`, err, data, getPlayerId(data));
				rt = [ErrorEnum.Callback_await_error];
			}
		}
		if (rt == null) {
			this.logger.error('msg.handleCallback rt == null', key, getMsgName(key));
			rt = [ErrorEnum.Callback_rt_null];
		} else if (typeof rt === 'number') {
			rt = [rt]; // 针对返回ErrorEnum简化处理!
		} else if (!Array.isArray(rt) || typeof rt[0] !== 'number') {
			this.logger.error('msg.handleCallback rt invalid', rt, key, getMsgName(key));
			rt = [ErrorEnum.Callback_rt_invalid];
			// assert(false, `Callback_rt_invalid msg ${key}`);
		}

		this.handledNum++;
		// session和返回值打包发送回去
		socket.emit(NetEventEnum.eventCallbacked, [session, rt]);
		if (returndata) {
			returndata.data = rt;
		}
		return true;
	}
}

export function traceHandles(
	handles: MsgHandle[],
	top = 10,
	s = 0,
	per = false,
	logfunc = console.warn,
): void {
	for (const handle of handles) handle.trace(top, s, per, logfunc);
}
