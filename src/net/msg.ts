/*
管理消息：消息结构为一个array，
第一位为id:number,来自msgid.ts（之前第一位为string，虽然灵活但是效率低了）
MsgHandle 处理消息，包括callback消息
*/
import { strict as assert } from 'assert';
import { CostGuard, CostGuards } from '../public/profile';
import { getMsgName, NetEventEnum } from './msgid';
import type { LiteLogger } from "../public/log";
import type { EventCallbackFunc, EventMods } from '../public/Depends';
import { msgData, SimpleObj, Utils } from '../public/Depends';
import { ErrorEnum } from './ErrorEnum';

/**
 * Argument adaptation applied before invoking a business handler.
 */
export enum SocketParamEnum {
	noSocket, // 不带socket参数，一般用于客户端
	rawSocket, // 带socket参数，一般用于服务器进入游戏之前, login使用
	msgID,
	noClientId, // 移除第一个参数id,
	selfSocket, // 用self替代socket
}

/**
 * Minimal event sender required by business dispatchers.
 */
export interface SocketEmit {
	/**
	 * Sends a framed event; false means disconnected or synchronous encoding/size/send failure. True does not acknowledge delivery.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param args - Unpacked arguments; variadic send APIs start with a message ID.
	 */
	emit(event: string, args: msgData): void;
}

export const W10 = 10*10000; //十万

/**
 * Transforms handler arguments; a falsy result rejects the callback.
 */
export type MsgFilterFunc = (socket: SocketEmit, msgid: number, data: any[]) => any[];

// 对handle的参数装箱
/**
 * Adapts mutable handler arguments and optionally measures synchronous invocation cost.
 */
export class MsgGuard extends CostGuard {
	/**
	 * Creates MsgGuard with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 * @param self - Receiver bound as this during callback invocation.
	 * @param param - RPC configuration or handler argument adaptation, as specified by the signature.
	 */
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

	/**
	 * Sets argument adaptation and clears the previous filter.
	 * @param param - RPC configuration or handler argument adaptation, as specified by the signature.
	 */
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

	/**
	 * Replaces the callback and receiver; returns whether either changed.
	 * @param self - Receiver bound as this during callback invocation.
	 * @param objname - Diagnostic registration owner name.
	 */
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

	/**
	 * Enables/disables a registered message; closed RPC handlers return Msg_closed.
	 */
	closeMsg(close: boolean) {
		this.close = close;
	}

	/**
	 * Adapts the mutable argument array and invokes the registered handler.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 */
	trySocket(socket: SocketEmit, msgid: number, data: any[]): unknown {
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

/**
 * Stores message guards and warns when handler registrations are replaced.
 */
export class MsgGuards extends CostGuards {
	override guards: { [key: string]: MsgGuard } = {};

	/**
	 * Creates MsgGuards with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 */
	constructor(name: string, private readonly logger: LiteLogger) {
		super(name);
	}

	/**
	 * Gets or replaces a guard and updates argument adaptation.
	 * @param name - Diagnostic label.
	 * @param self - Receiver bound as this during callback invocation.
	 * @param param - RPC configuration or handler argument adaptation, as specified by the signature.
	 * @param objname - Diagnostic registration owner name.
	 */
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

	/**
	 * Returns the registered message guard by key.
	 * @param name - Diagnostic label.
	 */
	getMsgguard(name: string): MsgGuard {
		return this.guards[name] as MsgGuard;
	}

	/**
	 * Enables/disables a registered message; closed RPC handlers return Msg_closed.
	 */
	closeMsg(msgid: number, close: boolean) {
		const guard = this.guards[msgid];
		guard?.closeMsg(close);
	}
}

/**
 * Extracts a truthy object id property, or returns zero.
 */
export function getPlayerIdObj(obj: unknown) {
	if (obj == null) return 0;
	return typeof obj === 'object' ? (obj as any).id || 0 : 0;
}

// raw func 在data[0]
// playerobj func 在data[1]
/**
 * Looks for a player ID in the first two handler arguments for diagnostics.
 * @param data - Payload; session sending and business dispatch may modify the array in place.
 */
export function getPlayerId(data: msgData) {
	return getPlayerIdObj(data[0]) || getPlayerIdObj(data[1]);
}

/**
 * Stores one handler per numeric message ID and dispatches mutable message arrays.
 */
export class MsgHandle {
	/**
	 * Injected diagnostic logger; console implements the required contract.
	 */
	logger: LiteLogger;

	/**
	 * Creates MsgHandle with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 */
	constructor(name: string, log: LiteLogger) {
		this.name = name;
		this.logger = log;
		this.handles = new MsgGuards('msgGuards', this.logger);
	}

	/**
	 * Enables/disables a registered message; closed RPC handlers return Msg_closed.
	 */
	closeMsg(msgid: number, close: boolean) {
		this.handles.closeMsg(msgid, close);
	}

	/**
	 * Human-readable diagnostic label.
	 */
	name: string;

	handles: MsgGuards;

	/**
	 * Finds a guard by numeric message ID.
	 */
	getHandle(key: number): MsgGuard {
		return this.handles.getMsgguard(String(key));
	}

	/**
	 * Enables synchronous invocation profiling; promise completion time is excluded.
	 */
	setProfile(profile: boolean, printns = 10): void {
		this.handles.setProfile(profile, printns);
	}

	/**
	 * Registers or replaces a handler with argument adaptation and an optional bound receiver.
	 * @param callback - Business handler or request completion callback.
	 * @param self - Receiver bound as this during callback invocation.
	 * @param param - RPC configuration or handler argument adaptation, as specified by the signature.
	 * @param objname - Diagnostic registration owner name.
	 */
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

	/**
	 * Registers a map of numeric IDs using shared receiver and argument adaptation.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param self - Receiver bound as this during callback invocation.
	 * @param param - RPC configuration or handler argument adaptation, as specified by the signature.
	 * @param objname - Diagnostic registration owner name.
	 */
	registers(data: EventMods, self: unknown, param: SocketParamEnum | MsgFilterFunc, objname: string): void {
		// console.log('registers', data);
		for (const [key, func] of Object.entries(data)) {
			// assert(MsgId[key]);
			this.register(Number(key), func, self, param, objname);
		}
	}

	handledNum = 0;

	recvSockect = 0;

	/**
	 * Dispatches a mutable business message, removing the leading message ID.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param warning - Whether to log a missing handler.
	 */
	handleMsg(socket: SocketEmit, data: msgData, warning = true): boolean | Promise<boolean> {
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
	/**
	 * Dispatches a mutable message; RPC subclasses also write the result to rt.data.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param warning - Whether to log a missing handler.
	 */
	handleMsgRt(
		socket: SocketEmit,
		data: msgData,
		rt: SimpleObj,
		warning = true,
	): boolean | Promise<boolean> {
		return this.handleMsg(socket, data, warning);
	}

	/**
	 * Prints accumulated synchronous invocation statistics.
	 */
	trace(top = 10, s = 0, per = false, logfunc = console.warn): void {
		console.log('MsgHandle.trace', this.name, 'len', Utils.objectLen(this.handles));
		this.handles.trace(top, s, per, logfunc);
	}
}

function isPromise(promise:any) {
	return !!promise && typeof promise.then === 'function';
}

/**
 * Awaits a value and prints the resolved result for diagnostics.
 */
export async function logPromise(rt: any) {
	const rt2 = await rt;
	console.log(rt2);
}

/**
 * Invokes RPC handlers and sends error-first results with the request correlation number.
 */
export class MsgHandleCB extends MsgHandle {
	/**
	 * Dispatches a mutable business message, removing the leading message ID.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param warning - Whether to log a missing handler.
	 */
	override handleMsg(socket: SocketEmit, data: msgData, warning = true): Promise<boolean> {
		return this.handleCallback(socket, data, null, warning);
	}

	// 为了editor做的, 因为没法把返回值emit回去了!
	/**
	 * Dispatches a mutable message; RPC subclasses also write the result to rt.data.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param warning - Whether to log a missing handler.
	 */
	override handleMsgRt(
		socket: SocketEmit,
		data: msgData,
		rt: SimpleObj,
		warning = true,
	): Promise<boolean> {
		return this.handleCallback(socket, data, rt, warning);
	}

	cbSockect = 0;

	// see HttpClient.send
	/**
	 * Invokes RPC and emits cb2 with the trailing session and validated error-first result; modifies the request array.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param warning - Whether to log a missing handler.
	 */
	async handleCallback(
		socket: SocketEmit,
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
			const time = performance.now();
			try {
				rt = await rt;
				const timeout = performance.now() - time;
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

/**
 * Prints profiling statistics for multiple message handler collections.
 */
export function traceHandles(
	handles: MsgHandle[],
	top = 10,
	s = 0,
	per = false,
	logfunc = console.warn,
): void {
	for (const handle of handles) handle.trace(top, s, per, logfunc);
}
