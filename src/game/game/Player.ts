import { msgData } from "../../client";
import { GlobalContext } from "./GlobalContext";

export class Player {
    // level = 0;
    clientid = 0;
    playerid = 0;

    context: GlobalContext;
    
    constructor(context: GlobalContext, clientid: number, playerid: number) {
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
}
