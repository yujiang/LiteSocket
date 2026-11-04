import { ErrorEnum, FirstErrorRt, msgData, MsgId } from "../../../client";
import { IOServerSocket } from "../../../net/IOServerSocket";
import { MsgGameGateEnum } from "../../MsgGame";
import { ClientData } from "../GateClients";
import { GameData, GateGames } from "../GateGames";

function getGameRoomName(gameid: number, room: string): string {
    return `${gameid}:${room}`;
}

function onRoomOP(socket:IOServerSocket, op: string, room: string, clientid: number) {
    const custom: GameData = socket.customData;                
    const sroom = getGameRoomName(custom.gameid, room);
    custom.clients.io.opRoomId(op, sroom, clientid);
}

function onRoomBC(socket:IOServerSocket, room: string, msg: msgData) {
    const custom: GameData = socket.customData;                
    const sroom = getGameRoomName(custom.gameid, room);
    custom.clients.bc(sroom, msg);
}

function onExit(socket:IOServerSocket, clientid: number, why: string) {
    const custom: GameData = socket.customData;                
    const client = custom.clients.findById(clientid);
    if (client){
        const custom: ClientData = client.customData;
        custom.exit(why);
        if (why !== 'disconnect'){ // 不是自己因为disconnect发过去的
            client.disconnect();
        }
    }
}

function onGameInfo(socket:IOServerSocket, gameid:number):FirstErrorRt{
    const custom: GameData = socket.customData;                
    custom.gameid = gameid;
    return [ErrorEnum.ErrorOk];
}

export function bindGameMessage(games: GateGames){
    games.onMessage(MsgId.MSG_C2S_ROOM_OP,onRoomOP);
    games.onMessage(MsgId.MSG_C2S_ROOM_BC,onRoomBC);

    games.onMessage(MsgGameGateEnum.game2gate_exit,onExit);
    games.onCallback(MsgGameGateEnum.game2gate_info,onGameInfo);
}