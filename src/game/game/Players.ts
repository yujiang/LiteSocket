import { msgData, MsgId } from "../../client";
import { MsgGameGateEnum, MsgClientEnum } from "../MsgGame";
import { GameGate } from "./GameGate";
import { Player } from "./Player";

const ROOM_WORLD = "world"

export class Players{
    gate: GameGate;

    constructor(gate: GameGate){
        this.gate = gate;
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

    enterGame(clientid: number, playerid: number){
        let p = this.findPlayer(playerid);
        if(p || this.findClient(clientid)) return false;
        p = new Player(this.gate,clientid, playerid) 
        this.Players[playerid] = p;
        this.Clients[clientid] = p;
        this.opRoom("join", ROOM_WORLD, clientid)
        return true;
    }

    private exit(p:Player){
        delete this.Clients[p.clientid];
        delete this.Players[p.playerid];
        this.opRoom("leave", ROOM_WORLD, p.clientid)
        p.exit();
    }

    exitClient(clientid: number){
        let p = this.findClient(clientid);
        if(!p) return false;
        this.exit(p);
        return true;
    }

    // why = kickoff ...
    exitGame(playerid: number, why: string){
        let p = this.findPlayer(playerid);
        if(!p) return false;
        this.gate.sendMsg(MsgGameGateEnum.game2gate_exit, p.clientid, why);
        this.exit(p);
        return true;
    }

    // 广播消息
    bcChat(playerid: number, msg: string){
        this.bcRoom(ROOM_WORLD, MsgClientEnum.bc_chat, playerid, msg);
    }

    bcRoom(room: string, ...msg: msgData){
        this.gate.sendMsg(MsgId.MSG_C2S_ROOM_BC, room, msg);
    }    

    opRoom(op: string, room: string, clientid: number){
        this.gate.sendMsg(MsgId.MSG_C2S_ROOM_OP, op, room, clientid);
    }    
}