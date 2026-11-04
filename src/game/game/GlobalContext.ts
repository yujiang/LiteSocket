import { Players } from "./Players";
import type { GameGate } from "./GameGate";

export class GlobalContext {
    gameid: number;
    gate: GameGate;
    constructor(gameid: number, gate: GameGate) {
        this.gameid = gameid;
        this.gate = gate;
        this.players = new Players(this);
    }
    players: Players;
}
