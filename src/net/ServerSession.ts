import { msgData } from '../public/Depends';
import { LiteLogger } from "../public/log";
import { SessionCallback } from './SessionCallback';
import { SocketEmit, W10 } from './msg';

export interface ServerSessionSocket extends SocketEmit {
	connected?: boolean;
	session?: SessionCallback; // 调试直连使用
	logger?: LiteLogger;
	on(event: string | symbol, listener: (...args: any[]) => void): this;
}


// 只在IOServerSocket.createSocketCB创建
export class ServerSession extends SessionCallback {
	sock: ServerSessionSocket;

	constructor(name: string, logger:LiteLogger, sock: ServerSessionSocket) {
		// 对于服务器向客户端的发送, 一般通过sesssion不走socket底层,所以没有传入onTimeoutFunc
		super(name, logger, null);
		this.sock = sock;
	}

	sendNum = 0;

	override isSessionConnect() : boolean {
		return this.sock?.connected;
	}

	override emitMsg(mod: string, msg: msgData): void {
		this.sendNum++;
		if (this.sendNum % W10 === 0 && this.sock.logger) {
			this.sock.logger.warn(`${this.name} SockWrap send ${this.sendNum}`);
		}
		this.sock.emit(mod, msg);
	}
}

// export async function asendSock(
// 	sock: HttpSocket,
// 	data: msgData,
// 	timeout = 0,
// ) {
// 	if (sock.cb) {
// 		return sock.cb.asendSession(NetEventEnum.eventCallback, data, timeout);
// 	}
// 	return [ErrorEnum.Callback_not_find, null];
// }
