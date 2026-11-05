import { msgData, MsgId } from "../../../client";
import { IOServerSocket } from "../../../net/IOServerSocket";
import { GameData, GateGames } from "../GateGames";

function getGameRoomName(gameid: number, room: string): string {
    if (room.indexOf(":") >= 0){
        return room;
    }
    return `${gameid}:${room}`;
}

function _onRoomOP(socket:IOServerSocket, op: string, room: string, clientid: number) {
    const custom: GameData = socket.customData;                
    const sroom = getGameRoomName(custom.gameid, room);
    custom.context.clients.io.opRoomId(op, sroom, clientid);
}

function onRoomOP(socket:IOServerSocket, op: string, room: string|string[], clientid: number) {
    if (Array.isArray(room)){
        for (const r of room){
            _onRoomOP(socket, op, r, clientid);
        }
    }else{
        _onRoomOP(socket, op, room, clientid);
    }
}

function onRoomBC(socket:IOServerSocket, room: string, msg: msgData) {
    const custom: GameData = socket.customData;                
    const sroom = getGameRoomName(custom.gameid, room);
    custom.context.clients.bc(sroom, msg);
}

export function bindRoomMessage(games: GateGames){
    games.onMessage(MsgId.MSG_C2S_ROOM_OP,onRoomOP);
    games.onMessage(MsgId.MSG_C2S_ROOM_BC,onRoomBC);
}