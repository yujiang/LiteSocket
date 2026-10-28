import type { LiteLogger } from "../public/log";
import { NetEventEnum } from './msgid';
import { MsgHandle, MsgHandleCB, HttpSocketHandle } from './msg';
import type { msgData } from '../public/Depends';

export interface HttpSocketOn extends HttpSocketHandle {
	//$socketClientId?: number;
	//emit(event: string, args: msgData): void;
	on(event: string | symbol, listener: (...args: any[]) => void): this;
}

export class TypeHandle {
	name: string;

	logger: LiteLogger;

	constructor(name: string, logger: LiteLogger) {
		this.name = name;
		this.logger = logger;
	}

	handles: { [key: string]: MsgHandle } = {}; // new Map<string,msg_handle>();

	setProfile(profile: boolean, printns = 10): void {
		for (const h of Object.values(this.handles)) {
			h.setProfile(profile, printns);
		}
	}

	bindSocket(socket: HttpSocketOn): void {
		const msgs = [NetEventEnum.eventMod, NetEventEnum.eventCallback, NetEventEnum.eventBc];
		for (const msg of msgs) {
			const h = this.getMsghandle(msg);
			// socket.on(msg, (data) => this.handleTypeMsg(socket, msg, data));
			socket.on(msg, (data) => h.handleMsg(socket, data));
		}
	}

	handleTypeMsg(socket: HttpSocketOn, stype: string, data: msgData, warning = true): boolean {
		const h = this.handles[stype];
		if (!h) {
			if (warning){
				this.logger.warn(this.name, 'not find typehandle', stype);
			}
			return false;
		}
		return !! h.handleMsg(socket, data, warning);
	}

	getMsghandle(stype: string): MsgHandle {
		let h = this.handles[stype];
		if (!h) {
			h = new MsgHandle(`${this.name}.${stype}`, this.logger);
			this.handles[stype] = h;
		}
		return h;
	}

	getMsghandleCB(stype: string): MsgHandleCB {
		let h = this.handles[stype];
		if (!h) {
			h = new MsgHandleCB(`${this.name}.${stype}`, this.logger);
			this.handles[stype] = h;
		}
		return h as MsgHandleCB;
	}

	// 一般在服务器
	getMsghandleCallback(): MsgHandleCB {
		return this.getMsghandleCB(NetEventEnum.eventCallback);
	}

	// 某个消息刷钱, 禁掉他!
	closeMsg(msgid: number, close: boolean) {
		const msg = this.getMsghandle(NetEventEnum.eventMod);
		msg.closeMsg(msgid, close);
		const msg2 = this.getMsghandleCallback();
		msg2.closeMsg(msgid, close);
	}
}
