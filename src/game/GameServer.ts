import { LiteLogger, ClientParam, LiteClientOptionsInput, SocketReason, ErrorEnum } from "../client";
import { GameGate } from "./GameGate";

export class GameServer{
    gate: GameGate;
    id: number;
    constructor(id: number, logger: LiteLogger, param: ClientParam, opts: LiteClientOptionsInput = {}){
        this.id = id;
        this.gate = new GameGate("GameGate"+id, logger, param, opts);
    }

    async start(url: string) : Promise<boolean>{
        const rt = await this.gate.connectServer(url, (reason: SocketReason, err?: any)=>this.onDisconnect(reason, err));
        if(!rt) return false;
        if (rt) {
            this.gate.sendMsg(MsgGameGateEnum.game2gate_info, this.id);
        }
        this.fillMessages()
        return true;
    }

    onDisconnect(resaon: SocketReason, err?: any){   
        // 无所谓, 会自动重连的~
    }

    onGateDisconnect(id: number){
        this.exitGame(id);
    }

    //一下都是临时数据
    Players:Record<number,Player> = {}

    findPlayer(id: number){
        return this.Players[id];
    }

    enterGame(clientid: number){
        let p = this.findPlayer(clientid);
        if(p) return false;
        p = new Player(clientid) 
        this.Players[clientid] = p;
        return true;
    }

    exitGame(clientid: number){
        let p = this.findPlayer(clientid);
        if(!p) return false;
        delete this.Players[clientid];
        return true;
    }

    fillMessages(){
        this.gate.onClientCallback(MsgGameGateEnum.gate2game_entergame, 
            (clientid:number, param: any) => {
                const rt = this.enterGame(clientid);
                if (rt) {
                    return [ErrorEnum.ErrorOk];
                }
                return [ErrorEnum.ErrorError, "not enterGame"];
            }
        )
 
        this.gate.onClientCallback(MsgClientEnum.game_chat, 
            (clientid:number, desid: number, chat: string) => {
                const p1 = this.findPlayer(clientid);
                if(!p1) return [ErrorEnum.ErrorError, "client not in game"];
                const p2 = this.findPlayer(desid);
                if(!p2) return [ErrorEnum.ErrorError, "des not in game"];
                this.gate.sendClient(desid, [MsgClientEnum.c_chat, clientid, chat]);
                return [ErrorEnum.ErrorOk];
            }
        )
    }
}
