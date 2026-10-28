// gateServer 和 clients 连接

import { isCallbackMod, msgData, NetEventEnum, W10 } from "../client";
import { IOServer } from "../net/IOServer";
import { IOServerSocket } from "../net/IOServerSocket";
import { LiteServerClient } from "../net/LiteServerClient";

export class GateClients  extends IOServer {
    override onClientConnected(socket: IOServerSocket): void {
        // super.onClientConnected(socket); 忽略基本的bind，改用自己的绑定
        this.bindSocket(socket);
    }

    // 改变了常规的流程
    bindSocket(socket: LiteServerClient): void {
		const msgs = [NetEventEnum.eventMod, NetEventEnum.eventCallback];
		for (const msg of msgs) {
			socket.on(msg, (data) => this.routeMsg(socket, msg, data));
		}
		// socket.on(NetEventEnum.eventPack, (data) => this.unpackMsg(socket, data));
		socket.on(NetEventEnum.eventGate, (data) => this.handleGateMsg(socket, data));
	}

	handleGateMsg(socket: LiteServerClient, data: msgData) {
		this.modHandle.handleMsg(socket, data);
	}    

    routeMsgNum = 0;
	// 把客户端的消息转发给gameserver
	async routeMsg(hsocket: LiteServerClient, stype: string, data: msgData): Promise<void> {
		this.routeMsgNum++;
		if (this.routeMsgNum % W10 === 0) {
			this.logger.warn(`${this.name} routeMsg ${this.routeMsgNum}`);
		}

        const clientId = hsocket.id;
		const socket = this.findById(clientId);
		if (!socket) return;
		data.splice(1, 0, clientId); // insert clientID!
		if (isCallbackMod(stype)) {
			// 路由的作用！
			// client --> gate --> game --> gate --> client!
			// session放在末尾！
			const session = data[data.length - 1];
			const rt = await this.gate2game.asendMod(stype, data);
			this.onSendCallback();
			socket.emit(NetEventEnum.eventCallbacked, [session, rt]);
		} else {
			this.gate2game.sendMod(stype, data);
		}
	}
}
