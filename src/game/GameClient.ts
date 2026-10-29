import { ErrorEnum, IOClient, NetEventEnum } from "../client";
import { MsgClientEnum } from "./MsgGame";

export class GameClient extends IOClient{
    override createHandle(){
        super.createHandle();
        this.fillMessage()
    }

    logined = false
    async login() {
        const rt = await this.asendMod(NetEventEnum.eventGateCallback,[MsgClientEnum.gate_login])
        if (rt[0] == ErrorEnum.ErrorOk){
            this.logined = true
        }
        return rt;
    }
    gameid = 0;
    playerid = 0;
    async enterGame(gameid: number, playerid: number){
        const rt = await this.asendMod(NetEventEnum.eventGateCallback,[MsgClientEnum.gate_entergame,gameid,playerid])
        if (rt[0] == ErrorEnum.ErrorOk){
            this.gameid = gameid;
            this.playerid = playerid;
        }
        return rt;
    }

    async bcChat(msg: string){
        const rt = await this.asendMsg(MsgClientEnum.game_bcchat, msg);
        if (rt[0] == ErrorEnum.ErrorOk){
            // .. nothing            
        }
        else {
            console.log(`chat error`, rt);
        }
        return rt;
    }
    
    async chatDes(desid: number, msg: string){
        const rt = await this.asendMsg(MsgClientEnum.game_chat,desid, msg);
        if (rt[0] == ErrorEnum.ErrorOk){
            // .. nothing            
        }
        else {
            console.log(`chat error`, rt);
        }
        return rt;
    }

    async exit(){
        const rt = await this.asendMod(NetEventEnum.eventGateCallback, [MsgClientEnum.gate_exit]);
        if (rt[0] === ErrorEnum.ErrorOk) {
            this.logined = false;
            this.gameid = 0;
            this.playerid = 0;

            this.socket.disconnect();
        }
        return rt;
    }
    
    fillMessage(){
        this.onMessage(MsgClientEnum.c_chat, 
            (id: number, msg: string)=>{
            console.log(`player ${id} chat: ${msg}`)   
        })
        this.onBroadcast(MsgClientEnum.bc_chat, 
            (id: number, msg: string)=>{
            console.log(`player ${id} bcchat: ${msg}`)   
        })
    }
}
