import { ClientParam, ErrorEnum, EventReturn, FirstErrorRt, IOClient, LiteClientOptionsInput, LiteLogger, msgData, NetEventEnum, SocketParamEnum, SocketReason } from "../../client";
import { game2gate_info_error } from "../ErrorGame";
import { MsgGameGateEnum } from "../MsgGame";
import { setTimeout as delay } from 'node:timers/promises';

export type GameMessageHandler = (clientid: number, ...arg1: any[]) => void;
export type GameCallbackHandler = (clientid: number, ...arg1: any[]) => EventReturn;

// 位于GameServer, 连接Gate
export class GameGate extends IOClient{
    id: number;
    private registrationController?: AbortController;
    constructor(id: number, logger: LiteLogger, param: ClientParam, opts: LiteClientOptionsInput = {}) {
        opts.autoReconnect = true; // 必须可以重连
        const name = "GameGate" + id;
        super(name, logger, param, opts);
        this.id = id;
    }

    // start 只能调用一次!
    async start(url: string) : Promise<number>{
        let initialConnection = true;
        const connection = this.connectServer(url);
        // 首次连接失败后仍会自动重连，所以不能等连接成功才安装监听。
        this.socket.onEvent('connect', (times: string | number) => {
            if (!initialConnection) this.onReconnect(times as number);
        });
        const [connected] = await connection;
        initialConnection = false;
        if(!connected) return ErrorEnum.Net_notconnect;
        return this.onStated();
    }

    onStated(){
        return this.sendId("onStated");
    }

    onReconnect(times: number) {
        this.continueSendId(0);
    }

    async continueSendId(times: number){
        this.registrationController?.abort();
        const controller = new AbortController();
        this.registrationController = controller;
        try {
            // 最多重试 60 次；新的连接、断线和销毁都会取消旧的重试链。
            while (!controller.signal.aborted) {
                const rt = await this.sendId("onReconnect", controller.signal);
                if (controller.signal.aborted || rt !== game2gate_info_error.Game_already_registered || times >= 60) return;
                await delay(1000, undefined, { signal: controller.signal });
                times++;
            }
        } catch (error) {
            if (!controller.signal.aborted) throw error;
        } finally {
            if (this.registrationController === controller) this.registrationController = undefined;
        }
    }

    async sendId(from: string, signal?: AbortSignal) : Promise<number> {        // 连接和重连都进入!
        const registered : number = 
            (await this.asendCallbacke(MsgGameGateEnum.game2gate_info, this.id)) as number;
        if (!signal?.aborted) this.onRegistedId(registered);
        return registered;
    }

    override onDisconnect(reason: SocketReason, err?: any) {
        this.registrationController?.abort();
        super.onDisconnect(reason, err);
    }

    override destroy(why: string) {
        this.registrationController?.abort();
        super.destroy(why);
    }

    // 注册自己的id到gate的结果
    onRegistedId(rt: number){}

    sendClient(clientid: number, data: msgData){
        data.unshift(clientid);
        this.sendMod(NetEventEnum.eventGateMod, data);
    }

    async asendClient(clientid: number, data: msgData, timeoutms = 0): Promise<FirstErrorRt> {
        if (!this.callback) return [ErrorEnum.Net_notconnect, null];
        data.unshift(clientid);
        return this.callback.asendMod(NetEventEnum.eventGateCallback, data, timeoutms);
    }

    // 第一个参数不是msgid, 是clientid
    onClientMessage(msg: number, callback: GameMessageHandler) {
        this.modHandle.register(msg, callback, null, SocketParamEnum.noSocket, 'noraml')
    }

    onClientCallback(msg: number, callback: GameCallbackHandler) {
        this.cbHandle.register(msg, callback, null, SocketParamEnum.noSocket, 'noraml')
    }
}
