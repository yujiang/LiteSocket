import { strict as assert } from "node:assert";
import { ErrorEnum, LiteLogger, LiteOptionsInput, msgData, MsgId, NetEventEnum } from "../client";
import { GateClients, ClientData } from "./GateClients";
import { GameData, GateGames } from "./GateGames";
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
        this.clients = new GateClients("GateClients"+id, loggerClients, { checktimeout: true });
        this.games = new GateGames("GateGames"+id, loggerGames, { checktimeout: true });
        this.games.route = this.clients;
        this.clients.route = this.games;

        this.fillMessages();
        this.roomMessage();
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

    roomMessage() {
        this.games.onMessage(
            MsgId.MSG_C2S_ROOM_OP,
            (socket:IOServerSocket, op: string, room: string, clientid: number) => {
                const custom: GameData = socket.customData;                
                const sroom = `${custom.gameid}:${room}`;
                this.clients.io.opRoomId(op, sroom, clientid);
            }
        )

        this.games.onMessage(
            MsgId.MSG_C2S_ROOM_BC,
            (socket:IOServerSocket, room: string, msg: msgData) => {
                const custom: GameData = socket.customData;                
                const sroom = `${custom.gameid}:${room}`;
                this.clients.bc(sroom, msg);
            }
        )
    }

    // 装配消息
    fillMessages(){
        this.games.onMessage(MsgGameGateEnum.game2gate_exit,
            (socket:IOServerSocket, clientid: number, why: string) => {
                // const custom: GameCustomData = socket.customData;                
                const client = this.clients.findById(clientid);
                if (client){
                    const custom: ClientData = client.customData;
                    custom.exit(why);
                    if (why !== 'disconnect'){ // 不是自己因为disconnect发过去的
                        client.disconnect();
                    }
                }
            }
        );
        this.games.onCallback(MsgGameGateEnum.game2gate_info, 
            (socket:IOServerSocket, gameid:number) => {
                const custom: GameData = socket.customData;                
                custom.gameid = gameid;
                return [ErrorEnum.ErrorOk];
            }
        )
        this.clients.onCallback(MsgClientEnum.gate_login, 
            (socket:IOServerSocket) => {
                const custom: ClientData = socket.customData;                
                if (custom.logined) {
                    return [ErrorEnum.ErrorError, "logined"]
                }
                custom.logined = true;
                return [ErrorEnum.ErrorOk];
            }
        )
       this.clients.onCallback(MsgClientEnum.gate_entergame, 
            async (socket:IOServerSocket, gameid: number, playerid: number) => {
                const custom: ClientData = socket.customData;                
                if (!custom.logined) {
                    return [ErrorEnum.ErrorError, "not login"]
                }
                if (custom.gameid || custom.entering){
                    return [ErrorEnum.ErrorError, "already in game"]
                }
                if (!Number.isSafeInteger(playerid) || playerid <= 0) {
                    return [ErrorEnum.ErrorError, "invalid playerid"];
                }
                const game = this.games.findGame(gameid);
                if (!game){
                    return [ErrorEnum.ErrorError, "game not found"]
                }
                custom.entering = true;
                try {
                    const rt = await game.asendMod(
                        NetEventEnum.eventCallback,
                        [MsgGameGateEnum.gate2game_entergame, socket.id, playerid],
                        5000);
                    if (rt[0] !== ErrorEnum.ErrorOk){
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
        )

        this.clients.onCallback(MsgClientEnum.gate_exit, 
            async (socket:IOServerSocket) => {
                const custom: ClientData = socket.customData;                
                if (custom.entering) {
                    return [ErrorEnum.ErrorError, "entering game"];
                }
                if (!custom.logined){ //并没有登录
                    return [ErrorEnum.ErrorOk];
                }
                if (!custom.gameid){
                    custom.logined = false;
                    custom.playerid = 0;
                    return [ErrorEnum.ErrorOk];
                }
                const game = this.games.findGame(custom.gameid);
                if (!game){ //并没有在游戏中
                    custom.logined = false;
                    custom.gameid = 0;
                    custom.playerid = 0;
                    return [ErrorEnum.ErrorOk];
                }
                const rt = await game.asendCallback(MsgGameGateEnum.gate2game_exit, socket.id);
                if (rt[0] !== ErrorEnum.ErrorOk){
                    return rt;
                }
                custom.exit("gate_exit");
                return [ErrorEnum.ErrorOk];
            }
        )
    }
}
