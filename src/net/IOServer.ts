// 把 LiteServer(替代socket.io) + msgHandle + Log 合在一起

import { setTimeout as delay } from "node:timers/promises";
import { LiteOptionsInput } from "./LiteNet";
import { LiteLogger, logStar } from "../public/log";
import { ClientSocketClass, ListenResult, LiteServer } from "./LiteServer";
import { msgData } from "../public/Depends";
import { MsgHandle, MsgHandleCB, SocketParamEnum } from "./msg";
import { NetEventEnum, MsgId } from "./msgid";
import { TypeHandle } from "./TypeHandle";
import { LiteServerClient } from "./LiteServerClient";
import { IOServerSocket } from "./IOServerSocket";
import { ErrorEnum, EventReturn, FirstErrorRt } from "./ErrorEnum";

/**
 * Ordinary server handler receiving the connection before business arguments.
 */
export type LiteMessageSocketHandler = (arg0: IOServerSocket, ...arg1: any[]) => void;
/**
 * Server RPC handler receiving the connection and returning an error-first result.
 */
export type LiteCallbackSocketHandler = (arg0: IOServerSocket, ...arg1: any[]) => EventReturn;

/**
 * Server RPC timeout polling configuration, separate from transport options.
 */
export interface ServerParam {
    /**
     * Enables periodic RPC timeout checks; a request timeout alone does not enable polling.
     * @defaultValue false
     */
    checktimeout?: boolean; // 默认 false
    /**
     * RPC polling interval in milliseconds; nonpositive/nonfinite values use 1000.
     * @defaultValue 1000
     */
    checkIntervalMs?: number; // 默认 1000
    pendingMax?: number; // 默认 10
}

/**
 * Server lifecycle wrapper; occupied ports are retried every second without a retry limit.
 */
export class IOServerBase {
    /**
     * Creates IOServerBase with the supplied dependencies and configuration.
     * @param name - Diagnostic label.
     * @param logger - Logger implementing LiteLogger; console is supported.
     */
    constructor(name: string, logger: LiteLogger) {
        this.name = name;
        this.logger = logger;
    }

    /**
     * Human-readable diagnostic label.
     */
    name: string;

    /**
     * Injected diagnostic logger; console implements the required contract.
     */
    logger: LiteLogger;

    /**
     * Current listening transport server; may be unset before listen or after close.
     */
    io: LiteServer;

    /**
     * Starts listening, retrying EADDRINUSE every second without a limit; returns [success, error].
     * @param port - TCP port; zero requests an OS-assigned port.
     * @param opts - Transport overrides.
     */
    async listen(port: number, opts: LiteOptionsInput = {}): Promise<ListenResult> {
        this.close();
        this.logger.info('');
        this.logger.warn(`IOServerBase start listen:${port}`, opts);
        logStar(this.logger,`IOServerBase ${this.name} start listen:${port}`);
        let retries = 0;
        while (true) {
            const server = this.createServer(this.name, opts);
            this.io = server;
            this.configureServer(server);
            const result = await server.listenPromise(port, this.getClientFactory());
            if (result[0]) {
                this.logger.warn(`IOServer ${this.name} listened:${server.port}`);
                return result;
            }
            server.close();
            if (this.io === server) this.io = undefined;
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

    /** Installs connection lifecycle handlers before the transport starts accepting clients. */
    protected configureServer(server: LiteServer): void {}

    /** Returns the connection wrapper constructor passed atomically to transport listening. */
    protected getClientFactory(): ClientSocketClass {
        return LiteServerClient;
    }

    /**
     * Closes the current server; does not cancel an occupied-port retry loop already running.
     */
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

/**
 * Business server with shared numeric handlers and per-connection RPC registries.
 */
export class IOServer extends IOServerBase {
    /**
     * Business dispatcher grouped by transport event category.
     */
    handle: TypeHandle;
    /**
     * Ordinary numeric business-message handlers.
     */
    modHandle: MsgHandle;
    /**
     * RPC handlers keyed by numeric message ID.
     */
    cbHandle: MsgHandleCB;
    /**
     * RPC timeout-polling and application connection configuration.
     */
    param: ServerParam;
    private checkTimer?: ReturnType<typeof setInterval>;

    /**
     * Creates IOServer with the supplied dependencies and configuration.
     * @param name - Diagnostic label.
     * @param logger - Logger implementing LiteLogger; console is supported.
     * @param param - RPC configuration or handler argument adaptation, as specified by the signature.
     */
    constructor(name: string, logger: LiteLogger, param: ServerParam = {}) {
        super(name, logger);
        this.param = param;
        this.createHandle();
    }

    /**
     * Starts listening, retrying EADDRINUSE every second without a limit; returns [success, error].
     * @param port - TCP port; zero requests an OS-assigned port.
     * @param opts - Transport overrides.
     */
    override async listen(port: number, opts: LiteOptionsInput = {}): Promise<ListenResult> {
        const result = await super.listen(port, opts);
        if (result[0] && this.param.checktimeout) {
            const configuredInterval = this.param.checkIntervalMs;
            const interval = Number.isFinite(configuredInterval) && configuredInterval > 0 ? configuredInterval : 1000;
            // 所有连接共用一个超时检查器，避免为每个 socket 创建定时器。
            this.checkTimer = setInterval(() => {
                const now = performance.now();
                for (const socket of this.io?.clients.values() ?? []) {
                    if (socket instanceof IOServerSocket) socket.session?.checkTimeout(now);
                }
            }, interval);
            this.checkTimer.unref();
        }
        return result;
    }

    /**
     * Initializes dispatchers; calling again replaces existing handler collections.
     */
    createHandle(): void {
        this.handle = new TypeHandle(this.name, this.logger);
        this.modHandle = this.handle.getMsghandle(NetEventEnum.eventMod);
        this.cbHandle = this.handle.getMsghandleCallback();
        this.onCallback(
            MsgId.MSG_SYSTEM_QUERYHTTPSERVER,
            (socket:IOServerSocket, key: string) => {
                return key === 'name'
                ? [ErrorEnum.ErrorOk, this.name]
                : [ErrorEnum.ErrorError, `unknown key ${key}`];
            }
        );
    }

    protected override configureServer(server: LiteServer): void {
        this.createEventMod(server);
    }

    protected override getClientFactory(): ClientSocketClass {
        return IOServerSocket;
    }

    /**
     * Finds an indexed connection by server-assigned ID, or returns undefined.
     * @param id - Connection ID or RPC correlation number, as specified by this API.
     */
    findById(id: number): IOServerSocket | undefined {
        const socket = this.io?.findById(id);
        return socket instanceof IOServerSocket ? socket : undefined;
    }

    private createEventMod(server: LiteServer): void {
        server.onEvent('exception', (reason, details) => {
            this.logger.error('IOServer broadcast exception', reason, details);
        });
        server.onClient('exception', (client, reason, err) => {
            this.logger.error('client exception', client.id, reason, err);
        });
        server.onClient('client-error', (client, reason, err) => {
            this.logger.error('client error', client.id, reason, err);
        });
        server.onClient('client-connect', client => {
            this.logger.warn(`client ${client.id} ${getIp(client)} connected!`);
            // this.handleLifecycle(socket, MsgId.MSG_SYSTEM_CONNECT);
            this.onClientConnected(client as IOServerSocket);
        });
        server.onClient('client-disconnect', (client, reason) => {
            this.logger.warn(`client ${client.id} ${getIp(client)} disconnected!`);
            // this.disconnectSocket(client as IOServerSocket, String(reason));
            this.onClientDisconnected(client as IOServerSocket);
        });
    }

    // 比较常用,可以保留重载
    /**
     * Disposes the business connection and settles pending RPCs.
     */
    onClientDisconnected(socket: IOServerSocket): void {
        this.disconnectSocket(socket, 'client disconnect');
    }

    private disconnectSocket(socket: IOServerSocket, reason: string): void {
        if (!socket.dispose(reason)) return;
        this.logger.warn(`client ${socket.id} ${getIp(socket)} disconnect for ${reason}!`);
        // this.handleLifecycle(socket, MsgId.MSG_SYSTEM_DISCONNECT);
        // this.onClientDisconnected(socket);
    }

    // 比较常用,可以保留重载
    /**
     * Initializes the accepted business connection and binds message dispatchers.
     */
    onClientConnected(socket: IOServerSocket): void {
        socket.createSession(this.name);
        this.bindSocketMsg(socket);
    }

    /**
     * Binds shared business handlers to a server connection.
     */
    bindSocketMsg(socket: IOServerSocket): void {
        this.handle.bindSocket(socket);
    }

    //onClientDisconnected(socket: IOServerSocket): void {}

    /**
     * Releases timeout polling, settles connection RPCs, and closes the transport server.
     */
    override close(): void {
        clearInterval(this.checkTimer);
        this.checkTimer = undefined;
        for (const socket of Array.from(this.io?.clients.values() ?? [])) {
            if (socket instanceof IOServerSocket) this.onClientDisconnected(socket);
        }
        super.close();
    }

    /**
     * Broadcasts a business message to an existing room; missing rooms are ignored.
     * @param room - Process-local room name.
     * @param args - Unpacked arguments; variadic send APIs start with a message ID.
     */
    bc(room: string, args: msgData): void {
        this.logger.debug('ioserver.bc', room, args);
        this.io?.getRoom(room)?.broadcast(NetEventEnum.eventBc, args);
    }

    // 简化常见的调用
    /**
     * Registers one ordinary handler per message ID; duplicate registration replaces the previous handler with a warning.
     * @param msg - Positive numeric business message ID.
     * @param callback - Business handler or request completion callback.
     */
    onMessage(msg: number, callback: LiteMessageSocketHandler) {
        this.modHandle.register(msg, callback, null, SocketParamEnum.rawSocket, 'normal' )
    }

    // rpc call
    /**
     * Registers one RPC handler per ID; return an error code or [error code, ...results], synchronously or asynchronously.
     * @param msg - Positive numeric business message ID.
     * @param callback - Business handler or request completion callback.
     */
    onCallback(msg: number, callback: LiteCallbackSocketHandler) {
        this.cbHandle.register(msg, callback, null, SocketParamEnum.rawSocket, 'normal' )
    }

    /**
     * Requests disconnection by ID; returns whether the connection exists.
     * @param id - Connection ID or RPC correlation number, as specified by this API.
     * @param reason - Diagnostic or close reason.
     */
    kickoff(id: number, reason = 'kickoff'): boolean {
        return this.io?.kickoff(id, reason) ?? false;
    }

    /**
     * Requests disconnection with reason exit; returns whether the connection exists.
     * @param id - Connection ID or RPC correlation number, as specified by this API.
     */
    exit(id: number): boolean {
        return this.io?.exit(id) ?? false;
    }

    /**
     * Attaches incoming-message diagnostics; server lookup returns whether the connection exists.
     * @param id - Connection ID or RPC correlation number, as specified by this API.
     */
    observe(id: number, log:LiteLogger) : boolean {
        return this.io?.observe(id, log) ?? false;
    }

    /**
     * Enables/disables a registered message; closed RPC handlers return Msg_closed.
     */
    closeMsg(msgid: number, close: boolean) {
        this.handle.closeMsg(msgid, close)
    }

    /**
     * Sends through the specified category; client session sending appends a session/zero to the supplied array.
     * @param id - Connection ID or RPC correlation number, as specified by this API.
     * @param type - Wire event category.
     * @param args - Unpacked arguments; variadic send APIs start with a message ID.
     */
    sendMod(id: number, type: string, args: msgData) {
        const sock = this.findById(id);
        sock?.sendMod(type, args);
    }

    /**
     * Sends RPC through the specified category and appends the session to the supplied array.
     * @param id - Connection ID or RPC correlation number, as specified by this API.
     * @param type - Wire event category.
     * @param args - Unpacked arguments; variadic send APIs start with a message ID.
     * @returns Promise resolving to [error code, ...results].
     */
    async asendMod(id: number, type: string, args: msgData): Promise<FirstErrorRt> {
        const sock = this.findById(id);
        if (!sock) return [ErrorEnum.Net_notconnect, null];
        return sock.asendMod(type, args);
    }
}

