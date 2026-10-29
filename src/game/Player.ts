import { msgData } from "../client";
import { GameGate } from "./GameGate";

export class Player {
    // level = 0;
    clientid = 0;
    playerid = 0;

    gate: GameGate;
    
    constructor(gate: GameGate, clientid: number, playerid: number) {
        this.gate = gate;
        this.clientid = clientid;
        this.playerid = playerid;
    }

    sendClient(...msg: msgData){
        this.gate.sendClient(this.clientid, msg);
    }

    exit() {
        this.gate = undefined;
    }
}
