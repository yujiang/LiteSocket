// 把 LiteClient(替代socket.io) + NetCallback + msgHandle 合在一起

import type { LiteLogger } from "../public/log";
import { LiteClient, LiteClientOptionsInput, ClientEventFunc } from "./LiteClient";
import { NetEventEnum } from "./msgid";
import { ClientParam, ClientSession } from "./ClientSession";
import type { SocketReason } from "./LiteSocket";
import { MsgHandle, MsgHandleCB, SocketParamEnum } from "./msg";
import { TypeHandle } from "./TypeHandle";
import { ErrorEnum, EventRtFunc, EventVoidFunc, FirstErrorRt } from "./ErrorEnum";
import { msgData } from "../public/Depends";

/**
 * Business client providing numeric message dispatch and bidirectional session-based RPC.
 */
export class IOClient {
    /**
     * Current client transport; may be unset before connection setup or after cleanup.
     */
    socket: LiteClient;
    /**
     * Client RPC registry associated with the current transport; may be unset after cleanup.
     */
    callback: ClientSession;
    private checkTimer?: ReturnType<typeof setInterval>;

    /**
     * Human-readable diagnostic label.
     */
    name: string;    
    /**
     * Transport options; clients expose resolved options through getOpts().
     */
    opts: LiteClientOptionsInput;
    /**
     * RPC timeout-polling and application connection configuration.
     */
    param: ClientParam;

    /**
     * Injected diagnostic logger; console implements the required contract.
     */
    logger: LiteLogger;
 
    /**
     * Creates IOClient with the supplied dependencies and configuration.
     * @param name - Diagnostic label.
     * @param logger - Logger implementing LiteLogger; console is supported.
     * @param param - RPC configuration or handler argument adaptation, as specified by the signature.
     * @param opts - Transport overrides.
     */
    constructor(name: string, logger: LiteLogger, param: ClientParam, opts: LiteClientOptionsInput = {}) {
        this.name = name;
        this.param = param;
        this.opts = opts;
		// const { connectionId, checktimeout } = param;
        this.logger = logger;
        this.logger.info('IOClient', name, param, opts);
        this.createHandle();
    }

    /**
     * Returns the current transport server-assigned ID; requires an initialized connection.
     */
    getSocketId() {
        return this.socket.serverId;
    }

    /**
     * Business dispatcher grouped by transport event category.
     */
    handle: TypeHandle;

    /**
     * Ordinary numeric business-message handlers.
     */
    modHandle: MsgHandle;

    /**
     * Broadcast handlers keyed by numeric message ID.
     */
    bcHandle: MsgHandle;

    // client其实不需要
    /**
     * RPC handlers keyed by numeric message ID.
     */
    cbHandle: MsgHandleCB;

    /**
     * Initializes dispatchers; calling again replaces existing handler collections.
     */
    createHandle(): void {
        this.handle = new TypeHandle(this.name, this.logger);
        // this.handle.registerCallbacked(
        // 	this.callback.onCallbacked,
        // 	this.callback,
        // );
        this.modHandle = this.handle.getMsghandle(NetEventEnum.eventMod);
        this.bcHandle = this.handle.getMsghandle(NetEventEnum.eventBc);
        this.cbHandle = this.handle.getMsghandleCallback();
    }

    /**
     * Endpoint used for the most recent connection setup.
     */
    serverUrl?: string;

    // 因为是异步调用，时序的问题
    // 在connectServer 之后 on('disconnect')怕来不及
    /** Returns the same `[connected, reason]` result as `LiteClient.connectPromise()`.
     * @param url - WebSocket endpoint using ws:// or wss://.
     * @param disconnect - Observer for established connection loss; initial failures do not invoke it.
     * @param timeout - Connection and system-handshake timeout in milliseconds; defaults to connectTimeout (5000).
     * @returns Promise resolving to [connected, reason] after the system handshake or connection failure.
     */
    connectServer(url: string, disconnect: ClientEventFunc, timeout?: number): Promise<[boolean, string]>;
    /**
     * Replaces the transport and waits for the system handshake; resolves to [connected, reason]. Business registrations are retained.
     * @param url - WebSocket endpoint using ws:// or wss://.
     * @param timeout - Connection and system-handshake timeout in milliseconds; defaults to connectTimeout (5000).
     * @returns Promise resolving to [connected, reason] after the system handshake or connection failure.
     */
    connectServer(url: string, timeout?: number): Promise<[boolean, string]>;
    /**
     * Replaces the transport and waits for the system handshake; resolves to [connected, reason]. Business registrations are retained.
     * @param url - WebSocket endpoint using ws:// or wss://.
     * @param disconnectOrTimeout - Disconnect observer or connection timeout in milliseconds.
     * @param timeout - Connection and system-handshake timeout in milliseconds; defaults to connectTimeout (5000).
     * @returns Promise resolving to [connected, reason] after the system handshake or connection failure.
     */
    async connectServer(
        url: string,
        disconnectOrTimeout?: ClientEventFunc | number,
        timeout?: number,
    ): Promise<[boolean, string]> {
        this.close();
        this.serverUrl = url;
        const socket = new LiteClient(this.name, this.logger, this.opts);
        const callback = new ClientSession(this.name, this.logger, null);
        callback.resetSocket(socket);
        this.socket = socket;
        this.callback = callback;
        this.bindSocketCallback(socket, callback);
        if (this.param.checktimeout) {
            const configuredInterval = this.param.checkIntervalMs;
            const interval = Number.isFinite(configuredInterval) && configuredInterval > 0 ? configuredInterval : 1000;
            this.checkTimer = setInterval(() => {
                if (this.callback === callback) callback.onCheck();
            }, interval);
            // unref() 表示：这个定时器不应单独阻止 Node 进程退出。
            // 这是 Node 专有接口，浏览器定时器没有这个方法。
            (this.checkTimer as unknown as { unref?: () => void }).unref?.();
        }
        this.logger.info('connectServer', url);
        const connectPromise = typeof disconnectOrTimeout === 'number'
            ? socket.connectPromise(url, disconnectOrTimeout)
            : disconnectOrTimeout
                ? socket.connectPromise(url, disconnectOrTimeout, timeout)
                : timeout === undefined
                    ? socket.connectPromise(url)
                    : socket.connectPromise(url, timeout);
        const [rt, msg] = await connectPromise;
        this.logger.info('connectServer rt', rt, msg);
        if (this.socket !== socket) return [rt, msg];
        if (!rt && !socket.getOpts().autoReconnect) this.close(msg);
        return [rt, msg];
    }

    private bindSocketCallback(socket: LiteClient, callback: ClientSession) {
        socket.on(NetEventEnum.eventCallbacked, (data: msgData) => {
            // logger.info('socket.on', NetEventEnum.eventCallbacked, data);
            const [id, rt] = data;
            callback.onCallbacked(id, rt);
        });

        this.bindSocket(socket);
        // socket.on(NetEventEnum.eventPack, (data: msgData) => this.unpackMsg(socket, data));
        socket.onEvent('disconnect', (reason, err) => {
            if (this.socket === socket) this.onDisconnect(reason, err);
        });
        // 已经在litesocket logged.
        // socket.onEvent('error', (reason, err) => this.logger.error('IOClient socket error', reason, err));
        socket.onEvent('exception', (reason, details) => {
            // 已经在litesocket logged.
            // this.logger.error('IOClient socket exception', reason, err);
            // settleSendFailure(callback, reason, err);
            if (Array.isArray(details?.data)) {
                callback.onSendFailed(reason, details)
            }
        });
    }    

    private bindSocket(socket: LiteClient){
        this.handle.bindSocket(socket);
    }

	/**
	 * Returns the application-configured connectionId, or zero.
	 */
	getId() {
		return this.param.connectionId || 0;
	}

    /**
     * Settles pending requests after connection loss; retains transport state only with automatic reconnect.
     * @param reason - Diagnostic or close reason.
     */
    onDisconnect(reason: SocketReason, err?: any){
        if (this.socket?.getOpts().autoReconnect) {
            this.callback?.reset(ErrorEnum.Callback_disconnect, false, String(reason));
        } else {
            this.close(String(reason));
        }
        this.logger.warn(`onDisconnect ${this.name} for ${reason}`);
    }

    // 不用timeout, 并没有好的处理方法~
    // onTimeoutMsg(msg: number, data: CallbackData, timeout: number) {
    //     // 把timetout的事件存下来, 如果网络恢复, 再次发送? -- 算了, 
    //     // this.emit(SocketEvent.timeout, msg, data);
    //     // logTimeoutMsg('send', MsgId[msg], this.getId(), data[1], timeout);
    // }

    // 不用on + emit, 实践指出只需要配置 'disconnet'足够了
    // event not msg
    // override emit(event: SocketEvent, ...args: any[]) {
    //     this.events.emit(event, ...args);
    // }    
 
    // override on(event: SocketEvent, func: EventCallbackFunc, self: unknown, tag: string): this {
    //     this.events.on(event, func, self, tag);
    //     return this;
    // }

    /**
     * Sends an ordinary message using variadic [message ID, ...arguments].
     * @param args - Unpacked arguments; variadic send APIs start with a message ID.
     */
    sendMsg(...args: msgData): void {
        this.send(args);
    }

    /**
     * Sends variadic RPC [message ID, ...arguments] with the default timeout; resolves to [error code, ...results].
     * @param args - Unpacked arguments; variadic send APIs start with a message ID.
     * @returns Promise resolving to [error code, ...results].
     */
    asendCallback(...args: msgData) {
        return this.asend(args);
    }

    /**
     * Sends variadic RPC arguments and resolves to the error code only.
     * @param args - Unpacked arguments; variadic send APIs start with a message ID.
     */
    asendeMsg(...args: msgData) {
        return this.asende(args);
    }

    /**
     * Sends an ordinary message; connected session sending appends zero to the supplied array. No delivery acknowledgement is returned.
     * @param data - Payload; session sending and business dispatch may modify the array in place.
     */
    send(data: msgData): void {
        this.callback?.sendMod(NetEventEnum.eventMod, data);
    }

    /**
     * Sends through the specified category; client session sending appends a session/zero to the supplied array.
     * @param mod - Wire event category.
     * @param data - Payload; session sending and business dispatch may modify the array in place.
     */
    sendMod(mod: string, data: msgData): void {
        this.callback?.sendMod(mod, data);
    }

    /**
     * Sends RPC and resolves to [error code, ...results]; appends the session to the supplied array.
     * @param data - Payload; session sending and business dispatch may modify the array in place.
     * @param timeoutms - RPC timeout in milliseconds; zero uses timeoutMax (100000 by default). Enable checktimeout or poll manually.
     * @returns Promise resolving to [error code, ...results].
     */
    asend(data: msgData, timeoutms = 0): Promise<FirstErrorRt> {
        return this.asendMod(NetEventEnum.eventCallback, data, timeoutms);
    }

    /**
     * Sends RPC through the specified category and appends the session to the supplied array.
     * @param mod - Wire event category.
     * @param data - Payload; session sending and business dispatch may modify the array in place.
     * @param timeoutms - RPC timeout in milliseconds; zero uses timeoutMax (100000 by default). Enable checktimeout or poll manually.
     * @returns Promise resolving to [error code, ...results].
     */
    async asendMod(mod: string, data: msgData, timeoutms = 0): Promise<FirstErrorRt> {
        if (!this.callback) return [ErrorEnum.Net_notconnect, null];
        return this.callback.asendMod(mod, data, timeoutms);
    }

    /**
     * Sends RPC and resolves to the error code only; appends the session to the supplied array.
     * @param data - Payload; session sending and business dispatch may modify the array in place.
     * @param timeoutms - RPC timeout in milliseconds; zero uses timeoutMax (100000 by default). Enable checktimeout or poll manually.
     * @returns Promise resolving to the error code only.
     */
    async asende(data: msgData, timeoutms = 0): Promise<ErrorEnum> {
        if (!this.callback) return ErrorEnum.Net_notconnect;
        return this.callback.asendModReturnError(NetEventEnum.eventCallback, data, timeoutms);
    }

    private close(reason?: string) {
        const socket = this.socket;
        const callback = this.callback;
        clearInterval(this.checkTimer);
        this.checkTimer = undefined;
        this.socket = undefined;
        this.callback = undefined;
        socket?.destroy();
        callback?.reset(ErrorEnum.Callback_disconnect, false, reason);
        callback?.close();
    }

    /**
     * Closes transport, releases timers, and settles pending RPCs with Callback_disconnect.
     * @param why - Diagnostic reason for releasing the client.
     */
    destroy(why: string) {
        if (!this.socket) {
            return;
        }
        // getLogApp().warn('closeSocket', this.name, why);
        this.logger.warn('destroy', why, this.serverUrl);
        this.close(why);
    }
   
    /**
     * Registers one ordinary handler per message ID; duplicate registration replaces the previous handler with a warning.
     * @param msg - Positive numeric business message ID.
     * @param callback - Business handler or request completion callback.
     */
    onMessage(msg: number, callback: EventVoidFunc) {
        this.modHandle.register(msg, callback, null, SocketParamEnum.noSocket, 'noraml')
	}

    /**
     * Registers one broadcast handler per message ID; duplicates replace the previous handler.
     * @param msg - Positive numeric business message ID.
     * @param callback - Business handler or request completion callback.
     */
    onBroadcast(msg: number, callback: EventVoidFunc) {
        this.bcHandle.register(msg, callback, null, SocketParamEnum.noSocket, 'noraml')
	}

    /**
     * Registers one RPC handler per ID; return an error code or [error code, ...results], synchronously or asynchronously.
     * @param msg - Positive numeric business message ID.
     * @param callback - Business handler or request completion callback.
     */
    onCallback(msg: number, callback: EventRtFunc) {
        this.cbHandle.register(msg, callback, null, SocketParamEnum.noSocket, 'noraml')
	}

}
