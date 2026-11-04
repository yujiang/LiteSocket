import { MsgClientEnum } from "../../MsgGame";
import type { GameClient } from "../GameClient";

function onChat(this: GameClient, id: number, msg: string) {
    console.log(this.logId(), `player ${id} chat: ${msg}`);
}

function onBroadcastChat(this: GameClient, id: number, msg: string) {
    console.log(this.logId(), `player ${id} bcchat: ${msg}`);
}

export function bindChatMessage(client: GameClient) {
    client.onMessage(MsgClientEnum.c_chat, onChat.bind(client));
    client.onBroadcast(MsgClientEnum.bc_chat, onBroadcastChat.bind(client));
}
