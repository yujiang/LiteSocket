import { ErrorEnum, FirstErrorRt } from "../../../client";
import { MsgGameGateEnum } from "../../MsgGame";
import { GameGate } from "../GameGate";
import type { GlobalContext } from "../GlobalContext";

function onEnterGame(this: GlobalContext, clientid:number, playerid: number) : FirstErrorRt {
    const rt = this.players.enterGame(clientid, playerid);
    if (rt) {
        return [ErrorEnum.ErrorOk];
    }
    return [ErrorEnum.ErrorError, "not enterGame"];
}
        
function onExit(this: GlobalContext, clientid:number) : FirstErrorRt {
    this.players.exitClient(clientid);
    return [ErrorEnum.ErrorOk];
}
        
function onDisconnect(this: GlobalContext, clientid: number) {
    if (this.players.exitClient(clientid)){
        this.gate.sendMsg(MsgGameGateEnum.game2gate_exit, clientid, 'disconnect');
    }
}

export function bindGateMessage(gate: GameGate, context: GlobalContext) {
    gate.onClientCallback(MsgGameGateEnum.gate2game_entergame,onEnterGame.bind(context));
    gate.onClientCallback(MsgGameGateEnum.gate2game_exit,onExit.bind(context));
    gate.onMessage(MsgGameGateEnum.gate2game_disconnect,onDisconnect.bind(context));
}
