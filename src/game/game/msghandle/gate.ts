import { ErrorEnum, FirstErrorRt } from "../../../client";
import { MsgGameGateEnum } from "../../MsgGame";
import { GameGate } from "../GameGate";
import type { GlobalGame } from "../GlobalGame";

function onEnterGame(this: GlobalGame, clientid:number, playerid: number) : FirstErrorRt {
    const rt = this.players.enterGame(clientid, playerid);
    if (rt) {
        return [ErrorEnum.ErrorOk];
    }
    return [ErrorEnum.ErrorError, "not enterGame"];
}
        
function onExit(this: GlobalGame, clientid:number) : FirstErrorRt {
    this.players.exitClient(clientid);
    return [ErrorEnum.ErrorOk];
}
        
function onDisconnect(this: GlobalGame, clientid: number) {
    if (this.players.exitClient(clientid)){
        this.gate.sendMsg(MsgGameGateEnum.game2gate_exit, clientid, 'disconnect');
    }
}

export function bindGateMessage(gate: GameGate, context: GlobalGame) {
    gate.onClientCallback(MsgGameGateEnum.gate2game_entergame,onEnterGame.bind(context));
    gate.onClientCallback(MsgGameGateEnum.gate2game_exit,onExit.bind(context));
    gate.onMessage(MsgGameGateEnum.gate2game_disconnect,onDisconnect.bind(context));
}
