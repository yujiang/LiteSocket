import { strict as assert } from "node:assert";
import { ErrorEnum, LiteLogger, LiteOptionsInput, NetEventEnum } from "../client";
import { GateClients, GateCustomData } from "./GateClients";
import { GameCustomData, GateGames } from "./GateGames";
import { IOServerSocket } from "../net/IOServerSocket";
import { ListenResult } from "../net/LiteServer";
import { MsgGameGateEnum, MsgClientEnum } from "./MsgGame";

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
        this.games.route = this.clients;
        this.clients.route = this.games;
        this.fillMessages();
    }
    
    // 内网的gateport < 1000, 外网的clientport > 1000 这样一眼可以区分
    async start(gateport: number, opts1: LiteOptionsInput, clientport: number, opts2: LiteOptionsInput) : Promise<ListenResult>{
        // 先对内,后对外
        assert(gateport < 1000, "gateport < 1000");
        // 0 由系统分配端口，供测试使用。
        assert(clientport === 0 || clientport >= 1000, "clientport >= 1000 or 0");
        const [rt1,error1] = await this.games.listen(gateport, opts1);
        if (!rt1){
            return [rt1,error1];
        }
        const [rt2,error2] = await this.clients.listen(clientport, opts2);
        if (!rt2){
            this.games.close();
            return [rt2,error2];
        }
        return [true];
    }

    // 装配消息
    fillMessages(){
        this.games.onCallback(MsgGameGateEnum.game2gate_info, 
            (socket:IOServerSocket, gameid:number) => {
                const custom: GameCustomData = socket.customData;                
                custom.gameid = gameid;
                return [ErrorEnum.ErrorOk];
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
            async (socket:IOServerSocket, gameid: number, playerid: number) => {
                const custom: GateCustomData = socket.customData;                
                if (!custom.logined) {
                    return [ErrorEnum.ErrorError, "not login"]
                }
                if (custom.gameid){
                    return [ErrorEnum.ErrorError, "already in game"]
                }
                if (!Number.isSafeInteger(playerid) || playerid <= 0) {
                    return [ErrorEnum.ErrorError, "invalid playerid"];
                }
                const game = this.games.findGame(gameid);
                if (!game){
                    return [ErrorEnum.ErrorError, "game not found"]
                }
                const rt = await game.asendMod(
                    NetEventEnum.eventCallback, 
                    [MsgGameGateEnum.gate2game_entergame, socket.id, playerid], 
                    5000);
                if (rt[0] !== ErrorEnum.ErrorOk){
                    return rt;
                }
                // 进入游戏期间可能断线，此时断线回调还不知道玩家已进入游戏。
                if (!socket.connected) {
                    game.sendMsg(MsgGameGateEnum.gate2game_clientdisconnect, socket.id);
                    return [ErrorEnum.Callback_disconnect];
                }
                custom.gameid = gameid;
                custom.playerid = playerid;
                console.log("[gate] enter game", gameid, socket.id, playerid);
                return [ErrorEnum.ErrorOk];
            }
        )

        this.clients.onCallback(MsgClientEnum.gate_exit, 
            async (socket:IOServerSocket) => {
                const custom: GateCustomData = socket.customData;                
                if (!custom.logined) {
                    return [ErrorEnum.ErrorOk];
                }
                if (!custom.gameid){
                    custom.logined = false;
                    custom.playerid = 0;
                    return [ErrorEnum.ErrorOk];
                }
                const game = this.games.findGame(custom.gameid);
                if (!game){
                    custom.logined = false;
                    custom.gameid = 0;
                    custom.playerid = 0;
                    return [ErrorEnum.ErrorOk];
                }
                const rt = await game.asendMod(
                    NetEventEnum.eventCallback, 
                    [MsgGameGateEnum.gate2game_exit, socket.id], 
                    5000);
                if (rt[0] !== ErrorEnum.ErrorOk){
                    return rt;
                }
                console.log("[gate] exit game", custom.gameid, socket.id, custom.playerid);
                custom.logined = false;
                custom.gameid = 0;
                custom.playerid = 0;
                return [ErrorEnum.ErrorOk];
            }
        )
    }
}
