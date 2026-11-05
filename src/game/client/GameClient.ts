import { ClientParam, ErrorEnum, IOClient, LiteClientOptionsInput, LiteLogger, NetEventEnum } from "../../client";
import { CPlayer } from "./CPlayer";
import { GlobalClient } from "./GlobalClient";
import { bindGameMessage } from "./msghandle/game";

export class GameClient {
    context: GlobalClient;
    client: IOClient;
    player: CPlayer;    
    constructor(name: string, logger: LiteLogger, param: ClientParam, opts: LiteClientOptionsInput = {}) {
        this.client = new IOClient(name, logger, param, opts);
        this.context = new GlobalClient(this);
        this.player = this.context.player;
        this.fillMessage()
    }
    
    fillMessage(){
        bindGameMessage(this.client, this.context);
    }
}
