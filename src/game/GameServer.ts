import { LiteLogger, ClientParam, LiteClientOptionsInput, SocketReason, ErrorEnum, msgData, MsgId } from "../client";
import { GameGate } from "./GameGate";
import { MsgGameGateEnum, MsgClientEnum } from "./MsgGame";
import { Player } from "./Player";

const ROOM_WORLD = "world"

export class GameServer{
    gate: GameGate;
    id: number;
    constructor(id: number, logger: LiteLogger, param: ClientParam, opts: LiteClientOptionsInput = {}){
        this.id = id;
        opts.autoReconnect = true;
        this.gate = new GameGate("GameServer"+id, logger, param, opts);
        this.fillMessages();
    }

    opRoom(op: string, room: string, clientid: number){
        this.gate.sendMsg(MsgId.MSG_C2S_ROOM_OP, op, room, clientid);
    }

    async start(url: string) : Promise<boolean>{
        const rt = await this.gate.connectServer(url, (reason: SocketReason, err?: any)=>this.onDisconnect(reason, err));
        if(!rt) return false;
        // 等 Gate 确认注册完成，再允许客户端进入游戏。
        const registered = await this.gate.asendCallback(MsgGameGateEnum.game2gate_info, this.id);
        return registered[0] === ErrorEnum.ErrorOk;
    }

    onDisconnect(resaon: SocketReason, err?: any){   
        // 无所谓, 会自动重连的~
    }

    // onGateDisconnect(id: number, playerid: number){this.exitGame(playerid);}

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
        p = new Player(clientid, playerid) 
        this.Players[playerid] = p;
        this.Clients[clientid] = p;
        this.opRoom("join", ROOM_WORLD, clientid)
        return true;
    }

    private exit(p:Player){
        delete this.Clients[p.clientid];
        delete this.Players[p.playerid];
        this.opRoom("leave", ROOM_WORLD, p.clientid)
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

    fillMessages(){
        this.gate.onClientCallback(MsgGameGateEnum.gate2game_entergame, 
            (clientid:number, playerid: number) => {
                const rt = this.enterGame(clientid, playerid);
                if (rt) {
                    return [ErrorEnum.ErrorOk];
                }
                return [ErrorEnum.ErrorError, "not enterGame"];
            }
        )
        this.gate.onClientCallback(MsgGameGateEnum.gate2game_exit, 
            (clientid:number) => {
                const rt = this.exitClient(clientid);
                return [ErrorEnum.ErrorOk];
            }
        )
 
        this.gate.onClientCallback(MsgClientEnum.game_chat, 
            (clientid:number, desid: number, chat: string) => {
                const p1 = this.findClient(clientid);
                if(!p1) return [ErrorEnum.ErrorError, "client not in game"];
                const p2 = this.findPlayer(desid);
                if(!p2) return [ErrorEnum.ErrorError, "des not in game"];
                this.gate.sendClient(p2.clientid, [MsgClientEnum.c_chat, p1.playerid, chat]);
                return [ErrorEnum.ErrorOk];
            }
        )

        this.gate.onClientCallback(MsgClientEnum.game_bcchat, 
            (clientid:number, chat: string) => {
                const p1 = this.findClient(clientid);
                if(!p1) return [ErrorEnum.ErrorError, "client not in game"];
                this.bcChat(p1.playerid, chat);
                return [ErrorEnum.ErrorOk];
            }
        )


        this.gate.onMessage(MsgGameGateEnum.gate2game_disconnect,
            (clientid: number) => {
                if (this.exitClient(clientid)){
                    this.gate.sendMsg(MsgGameGateEnum.game2gate_exit, clientid, 'disconnect');
                }
            }
        )
    }
}
