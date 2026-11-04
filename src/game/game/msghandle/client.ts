import { ErrorEnum } from "../../../client";
import { MsgClientEnum } from "../../MsgGame";
import { GameGate } from "../GameGate";

//this.gate.onClientCallback(MsgClientEnum.game_chat, 
function onChat(clientid: number, desid: number, chat: string) {
    const p1 = this.findClient(clientid);
    if (!p1) return [ErrorEnum.ErrorError, "client not in game"];
    const p2 = this.findPlayer(desid);
    if (!p2) return [ErrorEnum.ErrorError, "des not in game"];
    p2.sendClient(MsgClientEnum.c_chat, p1.playerid, chat);
    return [ErrorEnum.ErrorOk];
}


//this.gate.onClientCallback(MsgClientEnum.game_bcchat, 
function onBroadcastChat(clientid: number, chat: string) {
    const p1 = this.findClient(clientid);
    if (!p1) return [ErrorEnum.ErrorError, "client not in game"];
    this.bcChat(p1.playerid, chat);
    return [ErrorEnum.ErrorOk];
}

export function bindClientMessage(gate: GameGate) {
    gate.onClientCallback(MsgClientEnum.game_chat, onChat);
    gate.onClientCallback(MsgClientEnum.game_bcchat, onBroadcastChat);
}
