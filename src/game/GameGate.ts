import { ErrorEnum, EventReturn, FirstErrorRt, IOClient, LiteMessageHandler, msgData, NetEventEnum, SocketParamEnum } from "../client";

export type GameMessageHandler = (clientid: number, ...arg1: any[]) => void;
export type GameCallbackHandler = (clientid: number, ...arg1: any[]) => EventReturn;

// 位于GameServer, 连接Gate
export class GameGate extends IOClient{
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