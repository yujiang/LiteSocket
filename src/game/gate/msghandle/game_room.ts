import { msgData, MsgId } from "../../../client";
import { IOServerSocket } from "../../../net/IOServerSocket";
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

export function bindRoomMessage(games: GateGames){
    games.onMessage(MsgId.MSG_C2S_ROOM_OP,onRoomOP);
    games.onMessage(MsgId.MSG_C2S_ROOM_BC,onRoomBC);
}