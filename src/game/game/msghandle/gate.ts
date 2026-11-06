import { ErrorEnum } from "../../../client";
import { MsgGameGateEnum } from "../../MsgGame";
import { GameGate } from "../GameGate";
import type { GlobalGame } from "../GlobalGame";

function onEnterGame(this: GlobalGame, clientid:number, playerid: number) {
    return this.players.enterGame(clientid, playerid);
}
        
function onExit(this: GlobalGame, clientid:number) {
    return this.players.exitClient(clientid);
}
        
function onDisconnect(this: GlobalGame, clientid: number) {
    if (this.players.exitClient(clientid) === ErrorEnum.ErrorOk){
        this.gate.sendMsg(MsgGameGateEnum.game2gate_exit, clientid, 'disconnect');
    }
}

export function bindGateMessage(gate: GameGate, context: GlobalGame) {
    gate.onClientCallback(MsgGameGateEnum.gate2game_entergame,onEnterGame.bind(context));
    gate.onClientCallback(MsgGameGateEnum.gate2game_exit,onExit.bind(context));
    gate.onMessage(MsgGameGateEnum.gate2game_disconnect,onDisconnect.bind(context));
}
