// 参考HttpClient
// 把 LiteClient(替代socket.io) + NetCallback + msgHandle + Log 合在一起
// 支持asend ...

import type { LiteLogger } from "../public/log";
import { LiteClient, LiteClientOptionsInput, ClientEventFunc } from "./LiteClient";
import { NetEventEnum } from "./msgid";
import { ClientParam, ClientSession } from "./ClientSession";
import type { SocketReason } from "./LiteSocket";
import { MsgHandle, MsgHandleCB, SocketParamEnum } from "./msg";
import { TypeHandle } from "./TypeHandle";
import { settleSendFailure } from "./LiteUtils";
import { ErrorEnum, EventRtFunc, EventVoidFunc, FirstErrorRt } from "./ErrorEnum";
import { msgData } from "../public/Depends";

export class IOClient {
    socket: LiteClient;
    callback: ClientSession;
    private checkTimer?: ReturnType<typeof setInterval>;

    name: string;    
    opts: LiteClientOptionsInput;
    param: ClientParam;

    logger: LiteLogger;
 
    constructor(name: string, logger: LiteLogger, param: ClientParam, opts: LiteClientOptionsInput = {}) {
        this.name = name;
        this.param = param;
        this.opts = opts;
		// const { connectionId, checktimeout } = param;
        this.logger = logger;
        this.logger.info('IOClient', name, param, opts);
        this.createHandle();
    }

    getSocketId() {
        return this.socket.serverId;
    }

    handle: TypeHandle;

    modHandle: MsgHandle;

    bcHandle: MsgHandle;

    // client其实不需要
    cbHandle: MsgHandleCB;

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

    serverUrl?: string;

    disconnectFunc: ClientEventFunc;

    async connectServer(url: string, disconnect: ClientEventFunc): Promise<boolean> {
        this.close();
        this.serverUrl = url;
        const socket = new LiteClient(this.name, this.logger, this.opts);
        const callback = new ClientSession(this.name, this.logger, null);
        callback.resetSocket(socket);
        this.socket = socket;
        this.callback = callback;
        this.disconnectFunc = disconnect;
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
        const [rt, msg] = await socket.connectPromise(url);
        this.logger.info('connectServer rt', rt, msg);
        if (this.socket !== socket) return false;
        if (!rt && !socket.getOpts().autoReconnect) this.close(msg);
        return rt;
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
        socket.onEvent('error', (reason, err) => this.logger.error('IOClient socket error', reason, err));
        socket.onEvent('exception', (reason, err) => {
            this.logger.error('IOClient socket exception', reason, err);
            settleSendFailure(callback, reason, err);
        });
    }    

    private bindSocket(socket: LiteClient){
        this.handle.bindSocket(socket);
    }

	getId() {
		return this.param.connectionId || 0;
	}

    onDisconnect(reason: SocketReason, err?: any){
        const disconnect = this.disconnectFunc;
        if (this.socket?.getOpts().autoReconnect) {
            this.callback?.reset(ErrorEnum.Callback_disconnect, false, String(reason));
        } else {
            this.close(String(reason));
        }
        this.logger.warn(`onDisconnect ${this.name} for ${reason}`);
        // if (err) {
        //     this.logger.info(err);
        // }
        // this.emit(SocketEvent.disconnect, reason);
        disconnect?.(reason, err);
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

    sendMsg(...args: msgData): void {
        this.send(args);
    }

    asendCallback(...args: msgData) {
        return this.asend(args);
    }

    asendeMsg(...args: msgData) {
        return this.asende(args);
    }

    send(data: msgData): void {
        this.callback?.sendMod(NetEventEnum.eventMod, data);
    }

    sendMod(mod: string, data: msgData): void {
        this.callback?.sendMod(mod, data);
    }

    asend(data: msgData, timeoutms = 0): Promise<FirstErrorRt> {
        return this.asendMod(NetEventEnum.eventCallback, data, timeoutms);
    }

    async asendMod(mod: string, data: msgData, timeoutms = 0): Promise<FirstErrorRt> {
        if (!this.callback) return [ErrorEnum.Net_notconnect, null];
        return this.callback.asendMod(mod, data, timeoutms);
    }

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
        this.disconnectFunc = undefined;
        this.callback = undefined;
        socket?.destroy();
        callback?.reset(ErrorEnum.Callback_disconnect, false, reason);
        callback?.close();
    }

    destroy(why: string) {
        if (!this.socket) {
            return;
        }
        // getLogApp().warn('closeSocket', this.name, why);
        this.logger.warn('destroy', why, this.serverUrl);
        this.close(why);
    }

    // 不再考虑打包, 没有实际用到~

	// 开始打包，一批命令必须全部执行！
	// startPack() {
	// 	this.callback.startPack();
	// }

	// // 结束打包
	// endPack(timeout = 0): Promise<ErrorEnum> {
	// 	return this.callback.endPack(timeout);
	// }

	// async unpackMsg(socket: HttpSocket, data: msgData) {
	// 	const packs: [string, msgData][] = data;
	// 	for (const p of packs) {
	// 		const [type, msg] = p;
	// 		this.handle.handleTypeMsg(socket, type, msg);
	// 	}
	// }
    
    onMessage(msg: number, callback: EventVoidFunc) {
        this.modHandle.register(msg, callback, null, SocketParamEnum.noSocket, 'noraml')
	}

    onBroadcast(msg: number, callback: EventVoidFunc) {
        this.bcHandle.register(msg, callback, null, SocketParamEnum.noSocket, 'noraml')
	}

    onCallback(msg: number, callback: EventRtFunc) {
        this.cbHandle.register(msg, callback, null, SocketParamEnum.noSocket, 'noraml')
	}

}
