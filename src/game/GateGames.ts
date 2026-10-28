// gateServer 和 games 连接

import { NetEventEnum, isCallbackMod, msgData } from "../client";
import { IOServer } from "../net/IOServer";
import { IOServerSocket } from "../net/IOServerSocket";
import { GateClients } from "./GateClients";

export interface GameCustomData  {
	gameid: number;
}


export class GateGames extends IOServer {
	route: GateClients;

    override onClientConnected(socket: IOServerSocket): void {
        super.onClientConnected(socket);
		socket.customData = {
			gameid: 0,
		}
    }

    override bindSocket(socket: IOServerSocket): void {
        //处理aoi, 广播的消息
        super.bindSocket(socket);
        this.bindRoute(socket);
    }

    // 改变了常规的流程
    bindRoute(socket: IOServerSocket): void {
        const msgs = [NetEventEnum.eventGateMod, NetEventEnum.eventGateCallback];
        for (const msg of msgs) {
            socket.on(msg, (data) => this.routeMsg(socket, msg, data));
        }
    }

    // game的消息转发到client
    // 对应GameGate.sendClient
    async routeMsg(socket: IOServerSocket, stype: string, data: msgData) {
        let clientid = data.shift(); // [client,msgid, ...]  => [msgid, ...]
        if (isCallbackMod(stype)) {
			const session = data.pop();
			const rt = await this.route.asendMod(clientid, NetEventEnum.eventCallback, data);
			socket.emit(NetEventEnum.eventCallbacked, [session, rt]);
        }
        else {
            this.route.findById(clientid)?.sendMod(NetEventEnum.eventMod, data);
        }
    }

    findGame(gameid: number) : IOServerSocket {
        const clients = this.io.clients;
        for (const client of clients.values()) {
            const custom :GameCustomData = client.customData
            if (custom.gameid == gameid) {
                return client as IOServerSocket;
            }
        }
    }
}
