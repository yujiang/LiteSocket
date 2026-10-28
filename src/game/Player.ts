export class Player {
    level = 0;
    clientid = 0;
    playerid = 0;
    constructor(clientid: number, playerid: number) {
        this.clientid = clientid;
        this.playerid = playerid;
    }
}
