import { strict as assert } from "node:assert";
import { LiteLogger, LiteOptionsInput } from "../../client";
import { GateClients } from "./GateClients";
import { GateGames } from "./GateGames";
import { ListenResult } from "../../net/LiteServer";
import { bindClientMessage } from "./msghandle/client";
import { bindGameMessage } from "./msghandle/game";
import { GlobalGate } from "./GlobalGate";

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

    context: GlobalGate;
    constructor(id: number, loggerClients: LiteLogger, loggerGames: LiteLogger){
        this.id = id;
        this.clients = new GateClients("GateClients"+id, loggerClients, { checktimeout: true });
        this.games = new GateGames("GateGames"+id, loggerGames, { checktimeout: true });
        
        this.context = new GlobalGate(id, this.clients, this.games);
        this.clients.setContext(this.context);
        this.games.setContext(this.context);

        this.fillMessages();
        // this.roomMessage();
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
        bindClientMessage(this.clients)
        bindGameMessage(this.games)
    }
}
