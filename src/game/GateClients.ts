// gateServer 和 clients 连接

import { ErrorEnum, isCallbackMod, msgData, NetEventEnum, W10 } from "../client";
import { IOServer } from "../net/IOServer";
import { IOServerSocket } from "../net/IOServerSocket";
import { insertAt } from "../public/arrayUtils";
import { GateGames } from "./GateGames";
import { MsgGameGateEnum } from "./MsgGame";

export interface GateCustomData  {
	logined: boolean;
	gameid: number;
	playerid: number;
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
			playerid: 0,
			logined: false,
		}
        this.bindRoute(socket);
    }

	override onClientDisconnected(socket: IOServerSocket): void {
		super.onClientDisconnected(socket); 

		const custom: GateCustomData = socket.customData as any;
		if (custom.gameid && custom.playerid) {
			const game = this.route.findGame(custom.gameid);
			game?.sendMsg(MsgGameGateEnum.gate2game_clientdisconnect, socket.id);
		}
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
		
		// gameid 是业务编号，需要先找到对应的游戏服连接。
		const custom: GateCustomData = socket.customData as any;
		const game = custom?.gameid ? this.route.findGame(custom.gameid) : undefined;
		if (!game) {
			if (isCallbackMod(stype)) {
				socket.emit(NetEventEnum.eventCallbacked, [data[data.length - 1], [ErrorEnum.ErrorError, "game not found"]]);
			}
			return;
		}

		insertAt(data, 1, clientId); // [msgid, ...]  => [msgid, clientid, ...]
		if (isCallbackMod(stype)) {
			// 路由的作用！
			// client --> gate --> game --> gate --> client!
			// session放在末尾！
			// 每一段连接使用独立 session，先取出上一段的 session。
			const session = data.pop();
			const rt = await game.asendMod(stype, data);
			this.onSendCallback();
			socket.emit(NetEventEnum.eventCallbacked, [session, rt]);
		} else {
			game.sendMod(stype, data);
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
