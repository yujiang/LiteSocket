import { ErrorEnum, FirstErrorRt} from "../../../client";
import { IOServerSocket } from "../../../net/IOServerSocket";
import { MsgGameGateEnum } from "../../MsgGame";
import { ClientData } from "../GateClients";
import { GameData, GateGames } from "../GateGames";
import { bindRoomMessage } from "./game_room";

function onExit(socket:IOServerSocket, clientid: number, why: string) {
    const custom: GameData = socket.customData;                
    const client = custom.context.clients.findById(clientid);
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
    bindRoomMessage(games);

    games.onMessage(MsgGameGateEnum.game2gate_exit,onExit);
    games.onCallback(MsgGameGateEnum.game2gate_info,onGameInfo);
}