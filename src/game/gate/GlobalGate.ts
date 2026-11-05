// 此文件放所有的全局变量, 

import { GateClients } from "./GateClients";
import { GateGames } from "./GateGames";

export class GlobalGate {
    gateid: number;
    clients: GateClients;
    games: GateGames;

    constructor(gameid: number, clients: GateClients, games: GateGames) {
        this.gateid = gameid;
        this.clients = clients;
        this.games = games;
    }
}
