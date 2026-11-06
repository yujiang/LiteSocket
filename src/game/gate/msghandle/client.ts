import { ErrorEnum, FirstErrorRt, NetEventEnum, PFirstErrorRt } from "../../../client";
import { IOServerSocket } from "../../../net/IOServerSocket";
import { entergame_error, exit_error, login_error } from "../../ErrorGame";
import { MsgGameGateEnum, MsgClientEnum } from "../../MsgGame";
import { ClientData, GateClients } from "../GateClients";

function onLogin (socket: IOServerSocket)  {
    const custom: ClientData = socket.customData;
    if (custom.logined) {
        return login_error.logined;
    }
    custom.logined = true;
    return ErrorEnum.ErrorOk;
}

async function onEnterGame(socket: IOServerSocket, gameid: number, playerid: number) {
    const custom: ClientData = socket.customData;
    if (!custom.logined) {
        return entergame_error.not_login;
    }
    if (custom.gameid || custom.entering) {
        return entergame_error.already_in_game;
    }
    if (!Number.isSafeInteger(playerid) || playerid <= 0) {
        return entergame_error.invalid_playerid;
    }
    const game = custom.context.games.findGame(gameid);
    if (!game) {
        return entergame_error.game_not_found;
    }
    custom.entering = true;
    try {
        const rt = await game.asendMode(
            NetEventEnum.eventCallback,
            [MsgGameGateEnum.gate2game_entergame, socket.id, playerid],
            5000);
        if (rt !== ErrorEnum.ErrorOk) {
            return rt;
        }
        // 进入游戏期间可能断线，此时断线回调还不知道玩家已进入游戏。
        if (!socket.connected) {
            //game.sendMsg(MsgGameGateEnum.gate2game_disconnect, socket.id);
            return ErrorEnum.Callback_disconnect;
        }
        custom.gameid = gameid;
        custom.playerid = playerid;
        console.log(`[gate] game ${gameid} client ${socket.id} enter:`, playerid);
        return ErrorEnum.ErrorOk;
    } finally {
        custom.entering = false;
    }
}
    
async function onExit(socket: IOServerSocket) {
    const custom: ClientData = socket.customData;
    if (custom.entering) {
        return exit_error.entering_game;
    }
    if (!custom.logined) { //并没有登录
        return ErrorEnum.ErrorOk;
    }
    if (!custom.gameid) { //没进入游戏
        custom.logined = false;
        custom.playerid = 0;
        return ErrorEnum.ErrorOk;
    }
    const game = custom.context.games.findGame(custom.gameid);
    if (!game) { //并没有在游戏中
        custom.logined = false;
        custom.gameid = 0;
        custom.playerid = 0;
        return ErrorEnum.ErrorOk;
    }
    const rt = await game.asendCallbacke(MsgGameGateEnum.gate2game_exit, socket.id);
    if (rt !== ErrorEnum.ErrorOk) {
        return rt;
    }
    custom.exit("gate_exit");
    return ErrorEnum.ErrorOk;
}

export function bindClientMessage(clients: GateClients){
    clients.onCallback(MsgClientEnum.gate_login, onLogin);
    clients.onCallback(MsgClientEnum.gate_entergame, onEnterGame);
    clients.onCallback(MsgClientEnum.gate_exit, onExit);
}