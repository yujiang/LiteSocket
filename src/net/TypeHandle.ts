import type { LiteLogger } from "../public/log";
import { NetEventEnum } from './msgid';
import { MsgHandle, MsgHandleCB, SocketEmit } from './msg';
import type { msgData } from '../public/Depends';

/**
 * Event transport accepted by business message dispatchers.
 */
export interface SocketOn extends SocketEmit {
	//$socketClientId?: number;
	//emit(event: string, args: msgData): void;
	on(event: string | symbol, listener: (...args: any[]) => void): this;
}

/**
 * Routes transport event categories to ordinary, broadcast, and RPC handlers.
 */
export class TypeHandle {
	/**
	 * Human-readable diagnostic label.
	 */
	name: string;

	/**
	 * Injected diagnostic logger; console implements the required contract.
	 */
	logger: LiteLogger;

	/**
	 * Creates TypeHandle with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 * @param logger - Logger implementing LiteLogger; console is supported.
	 */
	constructor(name: string, logger: LiteLogger) {
		this.name = name;
		this.logger = logger;
	}

	handles: { [key: string]: MsgHandle } = {}; // new Map<string,msg_handle>();

	/**
	 * Enables synchronous invocation profiling; promise completion time is excluded.
	 */
	setProfile(profile: boolean, printns = 10): void {
		for (const h of Object.values(this.handles)) {
			h.setProfile(profile, printns);
		}
	}

	/**
	 * Binds mod, cb, and bc transport categories to business handlers.
	 */
	bindSocket(socket: SocketOn): void {
		const msgs = [NetEventEnum.eventMod, NetEventEnum.eventCallback, NetEventEnum.eventBc];
		for (const msg of msgs) {
			const h = this.getMsghandle(msg);
			// socket.on(msg, (data) => this.handleTypeMsg(socket, msg, data));
			socket.on(msg, (data) => h.handleMsg(socket, data));
		}
	}

	/**
	 * Dispatches by category; true for async handlers means dispatch started, not completed.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param warning - Whether to log a missing handler.
	 */
	handleTypeMsg(socket: SocketOn, stype: string, data: msgData, warning = true): boolean {
		const h = this.handles[stype];
		if (!h) {
			if (warning){
				this.logger.warn(this.name, 'not find typehandle', stype);
			}
			return false;
		}
		return !! h.handleMsg(socket, data, warning);
	}

	/**
	 * Gets or creates an ordinary handler collection for an event category.
	 */
	getMsghandle(stype: string): MsgHandle {
		let h = this.handles[stype];
		if (!h) {
			h = new MsgHandle(`${this.name}.${stype}`, this.logger);
			this.handles[stype] = h;
		}
		return h;
	}

	/**
	 * Gets or creates an RPC collection; the category must not already hold an ordinary collection.
	 */
	getMsghandleCB(stype: string): MsgHandleCB {
		let h = this.handles[stype];
		if (!h) {
			h = new MsgHandleCB(`${this.name}.${stype}`, this.logger);
			this.handles[stype] = h;
		}
		return h as MsgHandleCB;
	}

	// 一般在服务器
	/**
	 * Gets or creates the cb RPC handler collection.
	 */
	getMsghandleCallback(): MsgHandleCB {
		return this.getMsghandleCB(NetEventEnum.eventCallback);
	}

	// 某个消息刷钱, 禁掉他!
	/**
	 * Enables/disables a registered message; closed RPC handlers return Msg_closed.
	 */
	closeMsg(msgid: number, close: boolean) {
		const msg = this.getMsghandle(NetEventEnum.eventMod);
		msg.closeMsg(msgid, close);
		const msg2 = this.getMsghandleCallback();
		msg2.closeMsg(msgid, close);
	}
}
