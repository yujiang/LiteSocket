import { ErrorEnum, FirstErrorRt, NetEventEnum, PFirstErrorRt } from "../../../client";
import { IOServerSocket } from "../../../net/IOServerSocket";
import { MsgGameGateEnum, MsgClientEnum } from "../../MsgGame";
import { ClientData, GateClients } from "../GateClients";

function onLogin (socket: IOServerSocket) :FirstErrorRt {
    const custom: ClientData = socket.customData;
    if (custom.logined) {
        return [ErrorEnum.ErrorError, "logined"]
    }
    custom.logined = true;
    return [ErrorEnum.ErrorOk];
}

async function onEnterGame(socket: IOServerSocket, gameid: number, playerid: number):PFirstErrorRt {
    const custom: ClientData = socket.customData;
    if (!custom.logined) {
        return [ErrorEnum.ErrorError, "not login"]
    }
    if (custom.gameid || custom.entering) {
        return [ErrorEnum.ErrorError, "already in game"]
    }
    if (!Number.isSafeInteger(playerid) || playerid <= 0) {
        return [ErrorEnum.ErrorError, "invalid playerid"];
    }
    const game = custom.context.games.findGame(gameid);
    if (!game) {
        return [ErrorEnum.ErrorError, "game not found"]
    }
    custom.entering = true;
    try {
        const rt = await game.asendMod(
            NetEventEnum.eventCallback,
            [MsgGameGateEnum.gate2game_entergame, socket.id, playerid],
            5000);
        if (rt[0] !== ErrorEnum.ErrorOk) {
            return rt;
        }
        // 进入游戏期间可能断线，此时断线回调还不知道玩家已进入游戏。
        if (!socket.connected) {
            game.sendMsg(MsgGameGateEnum.gate2game_disconnect, socket.id);
            return [ErrorEnum.Callback_disconnect];
        }
        custom.gameid = gameid;
        custom.playerid = playerid;
        console.log(`[gate] game ${gameid} client ${socket.id} enter:`, playerid);
        return [ErrorEnum.ErrorOk];
    } finally {
        custom.entering = false;
    }
}
    
async function onExit(socket: IOServerSocket) :PFirstErrorRt {
    const custom: ClientData = socket.customData.context;
    if (custom.entering) {
        return [ErrorEnum.ErrorError, "entering game"];
    }
    if (!custom.logined) { //并没有登录
        return [ErrorEnum.ErrorOk];
    }
    if (!custom.gameid) {
        custom.logined = false;
        custom.playerid = 0;
        return [ErrorEnum.ErrorOk];
    }
    const game = custom.context.games.findGame(custom.gameid);
    if (!game) { //并没有在游戏中
        custom.logined = false;
        custom.gameid = 0;
        custom.playerid = 0;
        return [ErrorEnum.ErrorOk];
    }
    const rt = await game.asendCallback(MsgGameGateEnum.gate2game_exit, socket.id);
    if (rt[0] !== ErrorEnum.ErrorOk) {
        return rt;
    }
    custom.exit("gate_exit");
    return [ErrorEnum.ErrorOk];
}

export function bindClientMessage(clients: GateClients){
    clients.onCallback(MsgClientEnum.gate_login, onLogin);
    clients.onCallback(MsgClientEnum.gate_entergame, onEnterGame);
    clients.onCallback(MsgClientEnum.gate_exit, onExit);
}