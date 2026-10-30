// LiteServerClient + session + msgData的发送 

import type { WebSocket } from 'ws';
import { LiteServerClient } from './LiteServerClient';
import { LiteServer } from './LiteServer';
import type { LiteLogger } from "../public/log";
import type { ServerSessionSocket } from './ServerSession';
import { ServerSession } from './ServerSession';
import { NetEventEnum } from './msgid';
import type { clientEvent } from './LiteServer';
import type { SocketReason } from './LiteSocket';
import { msgData } from '../public/Depends';
import { ErrorEnum, FirstErrorRt } from './ErrorEnum';

/**
 * Business connection supporting ordinary messages and server-initiated RPC.
 */
export class IOServerSocket extends LiteServerClient implements ServerSessionSocket {
    /** Pending server-initiated RPC requests for this connection; initialized by createSession(). */
    session: ServerSession;

    /**
     * Creates IOServerSocket with the supplied dependencies and configuration.
     * @param name - Diagnostic label.
     * @param logger - Logger implementing LiteLogger; console is supported.
     * @param id - Connection ID or RPC correlation number, as specified by this API.
     */
    constructor(name: string, logger: LiteLogger, ws: WebSocket, server: LiteServer, id: number, remoteAddress = '') {
        super(name, logger, ws, server, id, remoteAddress);
    }

    /**
     * Clears local handlers/resources once; false means already disposed. Does not itself close the transport.
     * @param reason - Diagnostic or close reason.
     */
    override dispose(reason?: string): boolean {
        if (!super.dispose(reason)) return false;
        this.session?.reset(ErrorEnum.Callback_disconnect, false, reason);
        this.session?.close();
        return true;
    }

    /**
     * Dispatches a lifecycle or diagnostic event to observers.
     * @param eventName - Transport category or lifecycle name.
     * @param reason - Diagnostic or close reason.
     */
    override emitEvent(eventName: clientEvent, reason?: SocketReason, err?: any): void {
        if (eventName === 'exception' && this.session) {
            if (Array.isArray(err?.data)) {
                this.session.onSendFailed(reason, err);
            }
        }
        super.emitEvent(eventName, reason, err);
    }

    // 支持回调'cb'
    /**
     * Creates the server RPC registry and installs the cb2 response handler.
     * @param name - Diagnostic label.
     */
    createSession(name: string): void {
        this.session = new ServerSession(name, this.logger, this);

        this.on(NetEventEnum.eventCallbacked, (data: msgData) => {
            const [id, rt] = data;
            this.session.onSessionCallback(id, rt);
        });
    }

    /**
     * Sends the message through the specified category without appending a session or changing the array.
     * @param type - Wire event category.
     * @param msg - Numeric message ID or mutable business tuple, as specified by the signature.
     */
    sendMod(type: string, msg: msgData){
        if (this.session) {
            this.session.emitMsg(type, msg);
        }
        else {
            this.emit(type, msg);
        }
    }

    /**
     * Sends RPC through the specified category and appends the session to the supplied array.
     * @param type - Wire event category.
     * @param msg - Numeric message ID or mutable business tuple, as specified by the signature.
     * @param timeout - Timeout in milliseconds; RPC zero uses timeoutMax and requires timeout polling.
     * @returns Promise resolving to [error code, ...results].
     */
    async asendMod(type: string, msg: msgData, timeout = 0) : Promise<FirstErrorRt> {
        if (!this.session) {
            return [ErrorEnum.ErrorError, "!this.session"];
        }
        return this.session?.asendSession(type, msg, timeout);
    }

    /**
     * Sends an ordinary message using variadic [message ID, ...arguments].
     * @param args - Unpacked arguments; variadic send APIs start with a message ID.
     */
    sendMsg(...args: msgData) {
        this.sendMod(NetEventEnum.eventMod, args);
    }

    /**
     * Sends variadic RPC [message ID, ...arguments] with the default timeout; resolves to [error code, ...results].
     * @param args - Unpacked arguments; variadic send APIs start with a message ID.
     * @returns Promise resolving to [error code, ...results].
     */
    asendCallback(...args: msgData) : Promise<FirstErrorRt> {
        return this.asendMod(NetEventEnum.eventCallback, args);
    }
}
