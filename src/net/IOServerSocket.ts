import type { WebSocket } from 'ws';
import { LiteServerClient } from './LiteServerClient';
import { LiteServer } from './LiteServer';
import type { LiteLogger } from "../public/log";
import type { HttpSocket } from './msg';
import { ServerSession } from './ServerSession';
import { NetEventEnum } from './msgid';
import type { clientEvent } from './LiteServer';
import type { SocketReason } from './LiteSocket';
import { settleSendFailure } from './LiteUtils';
import { msgData } from '../public/Depends';
import { ErrorEnum } from './ErrorEnum';

// 主要是为了添加callback

export class IOServerSocket extends LiteServerClient implements HttpSocket {
    $socketClientId: number;
    session: ServerSession;

    constructor(name: string, logger: LiteLogger, ws: WebSocket, server: LiteServer, id: number, remoteAddress = '') {
        super(name, logger, ws, server, id, remoteAddress);
        this.$socketClientId = id;
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

    // 支持回调
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

    asendMod(type: string, msg: msgData, timeout = 0){
        return this.session?.asendSession(type, msg, timeout);
    }
}
