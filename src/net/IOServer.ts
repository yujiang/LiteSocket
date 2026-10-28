// 参考HttpServer
// 把 LiteServer(替代socket.io) + msgHandle + Log 合在一起

import { setTimeout as delay } from "node:timers/promises";
import { LiteMessageHandler, LiteOptionsInput } from "./LiteNet";
import { LiteLogger, logStar } from "../public/log";
import { ListenResult, LiteServer } from "./LiteServer";
import { strict as assert } from "node:assert";
import { msgData } from "../public/Depends";
import { MsgHandle, MsgHandleCB, SocketParamEnum } from "./msg";
import { NetEventEnum, MsgId } from "./msgid";
import { TypeHandle } from "./TypeHandle";
import { LiteServerClient } from "./LiteServerClient";
import { IOServerSocket } from "./IOServerSocket";
import { ErrorEnum, EventRtFunc } from "./ErrorEnum";

export class IOServerBase {
    constructor(name: string, logger: LiteLogger) {
        this.name = name;
        this.logger = logger;
    }

    name: string;

    logger: LiteLogger;

    io: LiteServer;

    async listen(port: number, opts: LiteOptionsInput = {}): Promise<ListenResult> {
        this.close();
        this.logger.info('');
        this.logger.warn(`IOServerBase start listen:${port}`, opts);
        logStar(this.logger,`IOServerBase ${this.name} start listen:${port}`);
        let retries = 0;
        while (true) {
            const server = this.createServer(this.name, opts);
            this.configureServer(server);
            const result = await server.listenPromise(port);
            if (result[0]) {
                this.io = server;
                this.logger.warn(`IOServer ${this.name} listened:${server.port}`);
                return result;
            }
            server.close();
            const error = result[1];
            if (error?.code !== 'EADDRINUSE') {
                this.logger.error(`IOServer ${this.name} listen ${port} error`, error);
                return result;
            }
            this.logger.warn(`IOServer ${this.name} listen ${port} in use, retrying...`, ++retries);
            await delay(1000);
        }
    }

    protected createServer(name: string, opts: LiteOptionsInput): LiteServer {
        return new LiteServer(name, this.logger, opts);
    }

    protected configureServer(server: LiteServer): void {}

    close() {
        const server = this.io;
        this.io = undefined;
        if (server) {
            this.logger.warn('IOServer.close()', server.getNameDisplay());
            server.close();
        }
    }
}

export function getIp(socket: LiteServerClient): string {
    const address = socket.remoteAddress;
    return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export class IOServer extends IOServerBase {
    handle: TypeHandle;
    modHandle: MsgHandle;
    cbHandle: MsgHandleCB;

    constructor(name: string, logger: LiteLogger) {
        super(name, logger);
        this.createHandle();
    }

    createHandle(): void {
        this.handle = new TypeHandle(this.name, this.logger);
        this.modHandle = this.handle.getMsghandle(NetEventEnum.eventMod);
        this.cbHandle = this.handle.getMsghandleCallback();
        this.cbHandle.register(
            MsgId.MSG_SYSTEM_QUERYHTTPSERVER,
            (key: string) => key === 'name'
                ? [ErrorEnum.ErrorOk, this.name]
                : [ErrorEnum.ErrorError, `unknown key ${key}`],
            null,
            SocketParamEnum.noSocket,
            'cbhandle',
        );
    }

    protected override configureServer(server: LiteServer): void {
        this.createEventMod(server);
    }

    protected override createServer(name: string, opts: LiteOptionsInput): LiteServer {
        return new LiteServer(name, this.logger, opts, (ws, server, id, address) =>
            new IOServerSocket(`${server.name}(${id})`, this.logger, ws, server, id, address));
    }

    findById(id: number): IOServerSocket | undefined {
        const socket = this.io?.findById(id);
        return socket instanceof IOServerSocket ? socket : undefined;
    }

    private createEventMod(server: LiteServer): void {
        server.onEvent('exception', (reason, details) => {
            this.logger.error('IOServer broadcast exception', reason, details);
        });
        server.onClient('exception', (client, reason, err) => {
            this.logger.error('IOServer client exception', client.id, reason, err);
        });
        server.onClient('client-error', (client, reason, err) => {
            this.logger.error('IOServer client error', client.id, reason, err);
        });
        server.onClient('client-connect', socket => {
            assert(socket instanceof IOServerSocket);
            this.logger.warn(`client ${socket.id} ${getIp(socket)} connected!`);
            // this.handleLifecycle(socket, MsgId.MSG_SYSTEM_CONNECT);
            this.onClientConnected(socket);
        });
        server.onClient('client-disconnect', (client, reason) => {
            if (client instanceof IOServerSocket) this.disconnectSocket(client, String(reason));
        });
    }

    // private handleLifecycle(socket: IOServerSocket, message: MsgId): void {
    //     //if (this.modHandle.getHandle(message)) {
    //     this.handle.handleTypeMsg(socket, NetEventEnum.eventMod, [message], false);
    //     //}
    // }

    private disconnectSocket(socket: IOServerSocket, reason: string): void {
        if (!socket.dispose(reason)) return;
        this.logger.warn(`client ${socket.$socketClientId} ${getIp(socket)} disconnect for ${reason}!`);
        // this.handleLifecycle(socket, MsgId.MSG_SYSTEM_DISCONNECT);
        this.onClientDisconnected(socket);
    }

    onClientConnected(socket: IOServerSocket): void {
        socket.createSocketCB(this.name);
        this.handle.bindSocket(socket);
    }
    
    onClientDisconnected(socket: IOServerSocket): void {}
   
    override close(): void {
        for (const socket of Array.from(this.io?.clients.values() ?? [])) {
            if (socket instanceof IOServerSocket) this.disconnectSocket(socket, 'server close');
        }
        super.close();
    }

    bc(room: string, args: msgData): void {
        this.logger.debug('ioserver.bc', room, args);
        this.io?.getRoom(room)?.broadcast(NetEventEnum.eventBc, args);
    }

    // 简化常见的调用
    onMessage<Handler extends (...args: any[]) => unknown>(msg: number, callback: LiteMessageHandler<Handler>) {
        this.modHandle.register(msg, callback, null, SocketParamEnum.rawSocket, 'normal' )
    }

    // rpc call
    onCallback(msg: number, callback: EventRtFunc) {
        this.cbHandle.register(msg, callback, null, SocketParamEnum.rawSocket, 'normal' )
    }

    kickoff(id: number, reason = 'kickoff'): boolean {
        return this.io?.kickoff(id, reason) ?? false;    
    }

    exit(id: number): boolean {
        return this.io?.exit(id) ?? false;    
    }

    observe(id: number, log:LiteLogger) : boolean {
        return this.io?.observe(id, log) ?? false;
    }

    closeMsg(msgid: number, close: boolean) {
        this.handle.closeMsg(msgid, close)
    }
}
