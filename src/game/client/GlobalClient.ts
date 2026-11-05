// 此文件放所有的全局变量, 
import { CPlayer } from "./CPlayer";
import { GameClient } from "./GameClient";

export class GlobalClient {
    player: CPlayer;
    client: GameClient;
    constructor(client: GameClient) {
        this.client = client;
        this.player = new CPlayer(this);
    }
}
