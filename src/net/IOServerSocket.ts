import type { WebSocket } from 'ws';
import { LiteServerClient } from './LiteServerClient';
import { LiteServer } from './LiteServer';
import type { LiteLogger } from "../public/log";
import type { HttpSocket } from './msg';
import { SockWrap } from './SockWrap';
import { NetEventEnum } from './msgid';
import type { clientEvent } from './LiteServer';
import type { SocketReason } from './LiteSocket';
import { settleSendFailure } from './LiteUtils';
import { msgData } from '../public/Depends';
import { ErrorEnum } from './ErrorEnum';

// 主要是为了添加callback

export class IOServerSocket extends LiteServerClient implements HttpSocket {
    $socketClientId: number;
    cb: SockWrap;

    constructor(name: string, logger: LiteLogger, ws: WebSocket, server: LiteServer, id: number, remoteAddress = '') {
        super(name, logger, ws, server, id, remoteAddress);
        this.$socketClientId = id;
    }

    override dispose(reason?: string): boolean {
        if (!super.dispose(reason)) return false;
        this.cb?.reset(ErrorEnum.Callback_disconnect, false, reason);
        this.cb?.close();
        return true;
    }

    override emitEvent(eventName: clientEvent, reason?: SocketReason, err?: any): void {
        if (eventName === 'exception') settleSendFailure(this.cb, reason, err);
        super.emitEvent(eventName, reason, err);
    }

    // 支持回调
    createSocketCB(name: string): void {
        this.cb = new SockWrap(name, this.logger, this);

        this.on(NetEventEnum.eventCallbacked, (data: msgData) => {
            const [id, rt] = data;
            this.cb.onSessionCallback(id, rt);
        });
    }

}
