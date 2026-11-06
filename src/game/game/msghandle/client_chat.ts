import { ErrorEnum, FirstErrorRt } from "../../../client";
import { chat_error } from "../../ErrorGame";
import { MsgClientEnum } from "../../MsgGame";
import { GameGate } from "../GameGate";
import type { GlobalGame } from "../GlobalGame";
import { ChatChannel } from "../Player";

function onChat(this: GlobalGame, clientid: number, desid: number, chat: string) {
    const p1 = this.players.findClient(clientid);
    if (!p1) return chat_error.client_not_ingame;
    const p2 = this.players.findPlayer(desid);
    if (!p2) return chat_error.des_not_ingame;
    // p2.sendClient(MsgClientEnum.c_chat, p1.playerid, chat);
    return p2.onPrivateChat(p1, chat);    
}

function onBroadcastChat(this: GlobalGame, clientid: number, chat: string, channel: string) {
    const p1 = this.players.findClient(clientid);
    if (!p1) return chat_error.client_not_ingame;
    return p1.bcChat(chat, channel as ChatChannel);
    // return [ErrorEnum.ErrorOk];
}

export function bindChatMessage(gate: GameGate, context: GlobalGame) {
    gate.onClientCallback(MsgClientEnum.game_chat, onChat.bind(context));
    gate.onClientCallback(MsgClientEnum.game_bcchat, onBroadcastChat.bind(context));
}
