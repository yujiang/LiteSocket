import { LiteLogger, ClientParam, LiteClientOptionsInput, SocketReason, ErrorEnum } from "../../client";
import { MsgGameGateEnum } from "../MsgGame";
import { GameGate } from "./GameGate";
import { bindClientMessage } from "./msghandle/client";
import { bindGateMessage } from "./msghandle/gate";
import { GlobalGame } from "./GlobalGame";


export class GameServer{
    gate: GameGate;
    id: number;
    context: GlobalGame;
    constructor(id: number, logger: LiteLogger, param: ClientParam, opts: LiteClientOptionsInput = {}){
        this.id = id;
        this.gate = new GameGate(id, logger, param, opts);
        this.context = new GlobalGame(id, this.gate);
        this.fillMessages();
    }

    start(url: string){
        return this.gate.start(url);
    }

    onStated(){}

    onDisconnect(resaon: SocketReason, err?: any){   
        // 无所谓, 会自动重连的~
    }

    fillMessages(){
        bindGateMessage(this.gate, this.context);
        bindClientMessage(this.gate, this.context);
    }
}
