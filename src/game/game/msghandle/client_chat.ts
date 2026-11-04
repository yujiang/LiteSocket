import { ErrorEnum, FirstErrorRt } from "../../../client";
import { MsgClientEnum } from "../../MsgGame";
import { GameGate } from "../GameGate";
import type { GlobalContext } from "../GlobalContext";

function onChat(this: GlobalContext, clientid: number, desid: number, chat: string) : FirstErrorRt {
    const p1 = this.players.findClient(clientid);
    if (!p1) return [ErrorEnum.ErrorError, "client not in game"];
    const p2 = this.players.findPlayer(desid);
    if (!p2) return [ErrorEnum.ErrorError, "des not in game"];
    p2.sendClient(MsgClientEnum.c_chat, p1.playerid, chat);
    return [ErrorEnum.ErrorOk];
}


function onBroadcastChat(this: GlobalContext, clientid: number, chat: string) : FirstErrorRt{
    const p1 = this.players.findClient(clientid);
    if (!p1) return [ErrorEnum.ErrorError, "client not in game"];
    this.players.bcChat(p1.playerid, chat);
    return [ErrorEnum.ErrorOk];
}

export function bindChatMessage(gate: GameGate, context: GlobalContext) {
    gate.onClientCallback(MsgClientEnum.game_chat, onChat.bind(context));
    gate.onClientCallback(MsgClientEnum.game_bcchat, onBroadcastChat.bind(context));
}
