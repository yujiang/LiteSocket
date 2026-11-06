// player on client
import { NetEventEnum, ErrorEnum, IOClient, msgData } from "../../client";
import { MsgClientEnum } from "../MsgGame";
import { GlobalClient } from "./GlobalClient";

export class CPlayer {
    context: GlobalClient;
    client: IOClient;
    constructor(context: GlobalClient) {
        this.context = context;
        this.client = context.client.client;
    }

    asendGate(...msg: msgData){
        return this.client.asendMod(NetEventEnum.eventGateCallback, msg);
    }

    logined = false
    async login() {
        const rt = await this.asendGate(MsgClientEnum.gate_login)
        if (rt[0] == ErrorEnum.ErrorOk){
            this.logined = true
        }
        return rt;
    }
    gameid = 0;
    playerid = 0;
    async enterGame(gameid: number, playerid: number){
        const rt = await this.asendGate(MsgClientEnum.gate_entergame, gameid, playerid);
        if (rt[0] == ErrorEnum.ErrorOk){
            this.gameid = gameid;
            this.playerid = playerid;
        }
        return rt;
    }

    async bcChat(msg: string, channel: string){
        const rt = await this.client.asendCallback(MsgClientEnum.game_bcchat, msg, channel);
        if (rt[0] == ErrorEnum.ErrorOk){
            // .. nothing            
        }
        else {
            this.log(`bcChat error`, rt[1]);
        }
        return rt;
    }
    
    async chatDes(desid: number, msg: string){
        const rt = await this.client.asendCallbacke(MsgClientEnum.game_chat,desid, msg);
        if (rt != ErrorEnum.ErrorOk){
            this.log(`chatDes error`, rt);
        }
        return rt;
    }

    async exit(){
        const rt = await this.asendGate(MsgClientEnum.gate_exit);
        if (rt[0] === ErrorEnum.ErrorOk) {
            this.logined = false;
            this.gameid = 0;
            this.playerid = 0;

            this.client.socket.disconnect();
        }
        return rt;
    }

    logId() {
        return `[${this.playerid}]`
    }

    // on msg ...
    onChat(id: number, msg: string) {
        this.log(`player ${id} chat: ${msg}`);
    }
    onBroadcastChat(id: number, msg: string, channel: string) {
        this.log(`[channel:${channel}] player ${id} bcchat:${msg}`);
    }

    log(...args: any[]) {
        console.log(this.logId(), ...args);
    }
}