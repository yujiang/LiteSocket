// gateServer 和 clients 连接

import { isCallbackMod, LiteOptionsInput, msgData, NetEventEnum, W10 } from "../client";
import { IOServer } from "../net/IOServer";
import { IOServerSocket } from "../net/IOServerSocket";
import { insertAt } from "../public/arrayUtils";
import { GateGames } from "./GateGames";

export interface GateCustomData  {
	logined: boolean;
	gameid: number;
}

// 一个Gate连接多个Client
export class GateClients extends IOServer {
	route: GateGames;

    override onClientConnected(socket: IOServerSocket): void {
		// 忽略基本的bind，改用自己的绑定, 
		// 这种用法不常见, 限于route的特殊性
        // super.onClientConnected(socket); 
		socket.createSession(this.name);

		socket.customData = {
			gameid: 0,
			logined: false,
		}
        this.bindRoute(socket);
    }
    

    // 改变了常规的流程
    bindRoute(socket: IOServerSocket): void {
		const msgs = [NetEventEnum.eventMod, NetEventEnum.eventCallback];
		for (const msg of msgs) {
			socket.on(msg, (data) => this.routeMsg(socket as IOServerSocket, msg, data));
		}
		// socket.on(NetEventEnum.eventPack, (data) => this.unpackMsg(socket, data));

		//处理进入游戏前的消息, 登录,选角色等等~
		socket.on(NetEventEnum.eventGate, (data) => this.modHandle.handleMsg(socket, data));
		socket.on(NetEventEnum.eventGateCallback, (data) => this.cbHandle.handleCallback(socket, data));
	}

    routeMsgNum = 0;
	// 把客户端的消息转发给gameserver
	async routeMsg(hsocket: IOServerSocket, stype: string, data: msgData): Promise<void> {
		this.routeMsgNum++;
		if (this.routeMsgNum % W10 === 0) {
			this.logger.warn(`${this.name} routeMsg ${this.routeMsgNum}`);
		}

        const clientId = hsocket.id;
		const socket = this.findById(clientId);
		if (!socket) return;
		
		// 如果没有绑定routeid == 游戏服
		const custom: GateCustomData = socket.customData as any;
		if (!custom?.gameid) return;

		insertAt(data, 1, clientId); // [msgid, ...]  => [msgid, clientid, ...]
		if (isCallbackMod(stype)) {
			// 路由的作用！
			// client --> gate --> game --> gate --> client!
			// session放在末尾！
			const session = data[data.length - 1];
			const rt = await this.route.asendMod(custom.gameid, stype, data);
			this.onSendCallback();
			socket.emit(NetEventEnum.eventCallbacked, [session, rt]);
		} else {
			this.route.sendMod(custom.gameid, stype, data);
		}
	}

	sendCbNum = 0;

	onSendCallback() {
		this.sendCbNum++;
		if (this.sendCbNum % W10 === 0) {
			this.logger.warn(`${this.name} onSendCb ${this.sendCbNum}`);
		}
	}

}
