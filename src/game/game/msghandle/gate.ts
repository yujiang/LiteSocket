import { ErrorEnum } from "../../../client";
import { GateClients } from "../../gate/GateClients";
import { MsgGameGateEnum } from "../../MsgGame";
import { GameGate } from "../GameGate";

function onEnterGame(clientid:number, playerid: number)  {
    const rt = this.enterGame(clientid, playerid);
    if (rt) {
        return [ErrorEnum.ErrorOk];
    }
    return [ErrorEnum.ErrorError, "not enterGame"];
}
        
function onExit(clientid:number)  {
    const rt = this.exitClient(clientid);
    return [ErrorEnum.ErrorOk];
}
        
function onDisconnect(clientid: number) {
    if (this.exitClient(clientid)){
        this.gate.sendMsg(MsgGameGateEnum.game2gate_exit, clientid, 'disconnect');
    }
}

export function bindGateMessage(gate: GameGate) {
    gate.onClientCallback(MsgGameGateEnum.gate2game_entergame,onEnterGame);
    gate.onClientCallback(MsgGameGateEnum.gate2game_exit,onExit);
    gate.onMessage(MsgGameGateEnum.gate2game_disconnect,onDisconnect);
}
