import { ClientParam, ErrorEnum, EventReturn, FirstErrorRt, IOClient, LiteClientOptionsInput, LiteLogger, msgData, NetEventEnum, SocketParamEnum, SocketReason } from "../../client";
import { game2gate_info_error } from "../ErrorGame";
import { MsgGameGateEnum } from "../MsgGame";
import { setTimeout as delay } from 'node:timers/promises';

export type GameMessageHandler = (clientid: number, ...arg1: any[]) => void;
export type GameCallbackHandler = (clientid: number, ...arg1: any[]) => EventReturn;

// 位于GameServer, 连接Gate
export class GameGate extends IOClient{
    id: number;
    constructor(id: number, logger: LiteLogger, param: ClientParam, opts: LiteClientOptionsInput = {}) {
        opts.autoReconnect = true; // 必须可以重连
        const name = "GameGate" + id;
        super(name, logger, param, opts);
        this.id = id;
    }

    // start 只能调用一次!
    async start(url: string) : Promise<number>{
        const [connected] = await this.connectServer(url, (reason: SocketReason, err?: any)=>this.onDisconnect(reason, err));
        if(!connected) return ErrorEnum.Net_notconnect;
        return this.onStated();
    }

    onStated(){
        this.socket.onEvent('connect', (times: string | number)=>this.onReconnect(times as number));
        return this.sendId("onStated");
    }

    onReconnect(times: number) {
        this.continueSendId(0);
    }

    async continueSendId(times: number){
        const rt = await this.sendId("onReconnect");
        // 如果老的还没有断线, 这有可能, 进程突然结束可以会这样, 所以不断尝试1分钟~
        if (rt === game2gate_info_error.Game_already_registered && times < 60) {
            await delay(1000);
            this.continueSendId(times + 1);
        }
        this.onRegistedId(rt);
    }

    async sendId(from: string) : Promise<number> {        // 连接和重连都进入!
        const registered : number = 
            (await this.asendCallbacke(MsgGameGateEnum.game2gate_info, this.id)) as number;
        this.onRegistedId(registered);
        return registered;
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