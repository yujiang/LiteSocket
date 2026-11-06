import { ErrorEnum, FirstErrorRt, msgData, MsgId } from "../../client";
import { chat_error, entergame_error, exit_error } from "../ErrorGame";
import { MsgGameGateEnum, MsgClientEnum } from "../MsgGame";
import type { GlobalGame } from "./GlobalGame";
import { ChatChannel, Player } from "./Player";

export const ROOM_WORLD = "world"
export const ROOM_GAMES = "0:games"


export class Players{
    context: GlobalGame;

    constructor(context: GlobalGame){
        this.context = context;
    }

    //一下都是临时数据
    Players:Record<number,Player> = {}
    Clients:Record<number,Player> = {}

    findPlayer(id: number){
        return this.Players[id];
    }
    findClient(id: number){
        return this.Clients[id];
    }

    enterGame(clientid: number, playerid: number) {
        if(this.findPlayer(clientid)) {
            return entergame_error.gameserver_player_in_game;
        }
        if(this.findClient(clientid)) {
            return entergame_error.gameserver_client_in_game;
        }
        const p = new Player(this.context,clientid, playerid) 
        this.Players[playerid] = p;
        this.Clients[clientid] = p;
        this.opRoom("join", [ROOM_WORLD, ROOM_GAMES], clientid)
        return ErrorEnum.ErrorOk;
    }

    private exit(p:Player){
        delete this.Clients[p.clientid];
        delete this.Players[p.playerid];
        this.opRoom("leave", [ROOM_WORLD, ROOM_GAMES], p.clientid)
        p.exit();
    }

    exitClient(clientid: number){
        let p = this.findClient(clientid);
        if(!p) return exit_error.gameserver_not_found_client;
        this.exit(p);
        return ErrorEnum.ErrorOk;
    }

    // why = kickoff ...
    exitGame(playerid: number, why: string){
        let p = this.findPlayer(playerid);
        if(!p) return false;
        this.context.gate.sendMsg(MsgGameGateEnum.game2gate_exit, p.clientid, why);
        this.exit(p);
        return ErrorEnum.ErrorOk;
    }

    // 广播消息到全服entergame的玩家
    bcChat(playerid: number, msg: string, channel: ChatChannel){
        switch(channel) {
            case "world":
                this.bcRoom(ROOM_WORLD, MsgClientEnum.bc_chat, playerid, msg, channel);
                break;
            case "games":
                this.bcRoom(ROOM_GAMES, MsgClientEnum.bc_chat, playerid, msg, channel);
                break;
            default:
                return chat_error.bcChat_unknown_channel;
        }
        return ErrorEnum.ErrorOk;
    }

    bcRoom(room: string, ...msg: msgData){
        this.context.gate.sendMsg(MsgId.MSG_C2S_ROOM_BC, room, msg);
    }    

    bcGates(...msg: msgData){
        this.bcRoom(ROOM_GAMES, ...msg);
    }    

    opRoom(op: string, room: string|string[], clientid: number){
        this.context.gate.sendMsg(MsgId.MSG_C2S_ROOM_OP, op, room, clientid);
    }    
}
