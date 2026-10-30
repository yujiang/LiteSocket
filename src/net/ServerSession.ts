import { msgData } from '../public/Depends';
import { LiteLogger } from "../public/log";
import { SessionCallback } from './SessionCallback';
import { SocketEmit, W10 } from './msg';

/**
 * Connection contract required by the server RPC registry.
 */
export interface ServerSessionSocket extends SocketEmit {
	connected?: boolean;
	session?: SessionCallback; // 调试直连使用
	/**
	 * Injected diagnostic logger; console implements the required contract.
	 */
	logger?: LiteLogger;
	on(event: string | symbol, listener: (...args: any[]) => void): this;
}


// 只在IOServerSocket.createSocketCB创建
/**
 * RPC registry for requests sent to one connected client.
 */
export class ServerSession extends SessionCallback {
	/**
	 * Server-side transport used by this RPC registry.
	 */
	sock: ServerSessionSocket;

	/**
	 * Creates ServerSession with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 * @param logger - Logger implementing LiteLogger; console is supported.
	 */
	constructor(name: string, logger:LiteLogger, sock: ServerSessionSocket) {
		// 对于服务器向客户端的发送, 一般通过sesssion不走socket底层,所以没有传入onTimeoutFunc
		super(name, logger, null);
		this.sock = sock;
	}

	sendNum = 0;

	/**
	 * Reports whether the RPC transport currently accepts requests.
	 */
	override isSessionConnect() : boolean {
		return this.sock?.connected;
	}

	/**
	 * Sends the mutable request through the bound server-side connection.
	 * @param mod - Wire event category.
	 * @param msg - Numeric message ID or mutable business tuple, as specified by the signature.
	 */
	override emitMsg(mod: string, msg: msgData): void {
		this.sendNum++;
		if (this.sendNum % W10 === 0 && this.sock.logger) {
			this.sock.logger.warn(`${this.name} SockWrap send ${this.sendNum}`);
		}
		this.sock.emit(mod, msg);
	}
}
