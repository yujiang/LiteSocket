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
        opts.autoReconnect = true;
        this.gate = new GameGate("GameServer"+id, logger, param, opts);
        this.context = new GlobalGame(id, this.gate);
        this.fillMessages();
    }

    async start(url: string) : Promise<boolean>{
        const [connected] = await this.gate.connectServer(url, (reason: SocketReason, err?: any)=>this.onDisconnect(reason, err));
        if(!connected) return false;
        // 等 Gate 确认注册完成，再允许客户端进入游戏。
        const registered = await this.gate.asendCallback(MsgGameGateEnum.game2gate_info, this.id);
        if (registered[0] !== ErrorEnum.ErrorOk) {
            return false;
        }
        return true;
    }

    onDisconnect(resaon: SocketReason, err?: any){   
        // 无所谓, 会自动重连的~
    }

    fillMessages(){
        bindGateMessage(this.gate, this.context);
        bindClientMessage(this.gate, this.context);
    }
}
