import { LiteLogger, ClientParam, LiteClientOptionsInput, SocketReason, ErrorEnum } from "../client";
import { GameGate } from "./GameGate";
import { MsgGameGateEnum, MsgClientEnum } from "./MsgGame";
import { Player } from "./Player";

export class GameServer{
    gate: GameGate;
    id: number;
    constructor(id: number, logger: LiteLogger, param: ClientParam, opts: LiteClientOptionsInput = {}){
        this.id = id;
        this.gate = new GameGate("GameServer"+id, logger, param, opts);
        this.fillMessages();
    }

    async start(url: string) : Promise<boolean>{
        const rt = await this.gate.connectServer(url, (reason: SocketReason, err?: any)=>this.onDisconnect(reason, err));
        if(!rt) return false;
        // 等 Gate 确认注册完成，再允许客户端进入游戏。
        const registered = await this.gate.asend([MsgGameGateEnum.game2gate_info, this.id], 5000);
        return registered[0] === ErrorEnum.ErrorOk;
    }

    onDisconnect(resaon: SocketReason, err?: any){   
        // 无所谓, 会自动重连的~
    }

    onGateDisconnect(id: number, playerid: number){
        this.exitGame(playerid);
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
        p = new Player(clientid, playerid) 
        this.Players[playerid] = p;
        this.Clients[clientid] = p;
        return true;
    }

    exitClient(clientid: number){
        let p = this.findClient(clientid);
        if(!p) return false;
        delete this.Clients[clientid];
        delete this.Players[p.playerid];
        return true;
    }

    exitGame(playerid: number){
        let p = this.findPlayer(playerid);
        if(!p) return false;
        delete this.Players[playerid];
        delete this.Clients[p.clientid];
        return true;
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

        this.gate.onMessage(MsgGameGateEnum.gate2game_clientdisconnect,
            (clientid: number) => {
                this.exitClient(clientid);
            }
        )
    }
}
