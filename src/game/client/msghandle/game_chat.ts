import { IOClient } from "../../../client";
import { MsgClientEnum } from "../../MsgGame";
import { GlobalClient } from "../GlobalClient";

function onChat(this: GlobalClient, id: number, msg: string) {
    // console.log(this.logId(), `player ${id} chat: ${msg}`);
    this.player.onChat(id, msg);
}

function onBroadcastChat(this: GlobalClient, id: number, msg: string, channel: string) {
    // console.log(this.logId(), `player ${id} bcchat: ${msg}`);
    this.player.onBroadcastChat(id, msg, channel);
}

export function bindChatMessage(client: IOClient, context: GlobalClient) {
    client.onMessage(MsgClientEnum.c_chat, onChat.bind(context));
    client.onBroadcast(MsgClientEnum.bc_chat, onBroadcastChat.bind(context));
}
