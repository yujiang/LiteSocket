import type { WebSocket } from 'ws';
import { LiteServerClient } from './LiteServerClient';
import { LiteServer } from './LiteServer';
import type { LiteLogger } from "../public/log";
import type { ServerSessionSocket } from './ServerSession';
import { ServerSession } from './ServerSession';
import { NetEventEnum } from './msgid';
import type { clientEvent } from './LiteServer';
import type { SocketReason } from './LiteSocket';
import { settleSendFailure } from './LiteUtils';
import { msgData } from '../public/Depends';
import { ErrorEnum, FirstErrorRt } from './ErrorEnum';

export class IOServerSocket extends LiteServerClient implements ServerSessionSocket {
    session: ServerSession;

    constructor(name: string, logger: LiteLogger, ws: WebSocket, server: LiteServer, id: number, remoteAddress = '') {
        super(name, logger, ws, server, id, remoteAddress);
    }

    override dispose(reason?: string): boolean {
        if (!super.dispose(reason)) return false;
        this.session?.reset(ErrorEnum.Callback_disconnect, false, reason);
        this.session?.close();
        return true;
    }

    override emitEvent(eventName: clientEvent, reason?: SocketReason, err?: any): void {
        if (eventName === 'exception') settleSendFailure(this.session, reason, err);
        super.emitEvent(eventName, reason, err);
    }

    // 支持回调'cb'
    createSession(name: string): void {
        this.session = new ServerSession(name, this.logger, this);

        this.on(NetEventEnum.eventCallbacked, (data: msgData) => {
            const [id, rt] = data;
            this.session.onSessionCallback(id, rt);
        });
    }

    sendMod(type: string, msg: msgData){
        if (this.session) {
            this.session.emitMsg(type, msg);
        }
        else {
            this.emit(type, msg);
        }
    }

    async asendMod(type: string, msg: msgData, timeout = 0) : Promise<FirstErrorRt> {
        if (!this.session) {
            return [ErrorEnum.ErrorError, "!this.session"];
        }
        return this.session?.asendSession(type, msg, timeout);
    }

    sendMsg(...args: msgData) {
        this.sendMod(NetEventEnum.eventMod, args);
    }

    asendCallback(...args: msgData) : Promise<FirstErrorRt> {
        return this.asendMod(NetEventEnum.eventCallback, args);
    }
}
