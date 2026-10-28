import assert from "node:assert";
import { ErrorEnum, LiteLogger, LiteOptionsInput, NetEventEnum } from "../client";
import { GateClients, GateCustomData } from "./GateClients";
import { GameCustomData, GateGames } from "./GateGames";
import { IOServerSocket } from "../net/IOServerSocket";
import { ListenResult } from "../net/LiteServer";

// 各种消息
// client->'g'->gateclients
// client->'gb'->gateclients--'cb2'-->client

// client->'mod'->gateclients->gategames--'gmod'->game 
// client->'cb'->gateclients->->gategames--'gcb'->game->gate--'cb2'->client

// game->'mod'->gategames
// game->'cb'->gategames-'cb2'->game

// game->'gmod'->gategames->gateclients--'mod'->client
// game->'gcb'->gategames->gateclients--'cb'->client->gate--'cb2'->game


export class GateServer {
    clients: GateClients;
    games: GateGames;

    id: number;
    constructor(id: number, loggerClients: LiteLogger, loggerGames: LiteLogger){
        this.id = id;
        this.clients = new GateClients("GateClients"+id, loggerClients);
        this.games = new GateGames("GateGames"+id, loggerGames);
    }
    
    // 内网的gateport < 1000, 外网的clientport > 1000 这样一眼可以区分
    async start(gateport: number, opts1: LiteOptionsInput, clientport: number, opts2: LiteOptionsInput) : Promise<ListenResult>{
        // 先对内,后对外
        assert(gateport < 1000, "gateport < 100");
        assert(clientport >= 1000, "clientport > 1000");
        const [rt1,error1] = await this.games.listen(gateport, opts1);
        if (!rt1){
            return [rt1,error1];
        }
        const [rt2,error2] = await this.clients.listen(clientport, opts2);
        if (!rt2){
            return [rt2,error2];
        }
        this.games.route = this.clients;
        this.clients.route = this.games;
        this.fillMessages()
        return [true];
    }

    // 装配消息
    fillMessages(){
        this.games.onMessage(MsgGameGateEnum.game2gate_info, 
            (socket:IOServerSocket, gameid:number) => {
                const custom: GameCustomData = socket.customData;                
                custom.gameid = gameid;
            }
        )
        this.clients.onCallback(MsgClientEnum.gate_login, 
            (socket:IOServerSocket) => {
                const custom: GateCustomData = socket.customData;                
                if (custom.logined) {
                    return [ErrorEnum.ErrorError, "logined"]
                }
                custom.logined = true;
                return [ErrorEnum.ErrorOk];
            }
        )
       this.clients.onCallback(MsgClientEnum.gate_entergame, 
            async (socket:IOServerSocket, gameid: number, param: any) => {
                const custom: GateCustomData = socket.customData;                
                if (!custom.logined) {
                    return [ErrorEnum.ErrorError, "not login"]
                }
                if (custom.gameid){
                    return [ErrorEnum.ErrorError, "already in game"]
                }
                const game = this.games.findGame(gameid);
                if (!game){
                    return [ErrorEnum.ErrorError, "game not found"]
                }
                const rt = await game.asendMod(
                    NetEventEnum.eventCallback, 
                    [MsgGameGateEnum.gate2game_entergame, socket.id, param], 
                    5000);
                if (rt[0] !== ErrorEnum.ErrorOk){
                    return rt;
                }
                custom.gameid = gameid;
                console.log("[gate] enter game", gameid, socket.id, param);
                return [ErrorEnum.ErrorOk];
            }
        )
    }
}