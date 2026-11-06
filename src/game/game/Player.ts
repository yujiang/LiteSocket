import { dateNow, ErrorEnum, FirstErrorRt, msgData } from "../../client";
import { chat_error } from "../ErrorGame";
import { MsgClientEnum } from "../MsgGame";
import { GlobalGame } from "./GlobalGame";

export type ChatChannel = "world" | "games";

export class Player {
    // level = 0;
    clientid = 0;
    playerid = 0;

    context: GlobalGame;
    
    constructor(context: GlobalGame, clientid: number, playerid: number) {
        this.context = context;
        this.clientid = clientid;
        this.playerid = playerid;
    }

    sendClient(...msg: msgData){
        this.context.gate.sendClient(this.clientid, msg);
    }

    exit() {
        this.context = undefined;
    }

    //
    onPrivateChat(player: Player, chat: string) {
        this.sendClient(MsgClientEnum.c_chat,player.playerid, chat);
        return ErrorEnum.ErrorOk;
    }

    // 广播消息到全服entergame的玩家
    prevBCTime = 0;
    bcChat(msg: string, channel: ChatChannel){
        const players = this.context.players;
        // 先检测自己的发言限制 ... 
        const now = dateNow();
        if (now - this.prevBCTime < 1000) {
            return chat_error.bcChat_too_fast;
        }
        this.prevBCTime = now;
        return players.bcChat(this.playerid, msg, channel);
    }

}
