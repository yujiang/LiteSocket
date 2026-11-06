import { ClientParam, ErrorEnum, EventReturn, FirstErrorRt, IOClient, LiteClientOptionsInput, LiteLogger, msgData, NetEventEnum, SocketParamEnum, SocketReason } from "../../client";
import { MsgGameGateEnum } from "../MsgGame";

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
    async start(url: string) : Promise<[ErrorEnum, string]>{
        const [connected] = await this.connectServer(url, (reason: SocketReason, err?: any)=>this.onDisconnect(reason, err));
        if(!connected) return [ErrorEnum.ErrorError, "Failed to connect"];
        return this.onStated();
    }

    onStated(){
        this.socket.onEvent('connect', (times: string | number)=>this.onReconnect(times as number));
        return this.sendId("onStated");
    }

    async onReconnect(times: number) {
        this.sendId("onReconnect");
    }

    async sendId(from: string) : Promise<[ErrorEnum, string]> {        // 连接和重连都进入!
        const registered = await this.asendCallback(MsgGameGateEnum.game2gate_info, this.id);
        return registered as [ErrorEnum, string];
    }

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