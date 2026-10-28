import { ErrorEnum, IOClient, NetEventEnum } from "../client";

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
    async enterGame(id: number){
        const rt = await this.asendMod(NetEventEnum.eventGateCallback,[MsgClientEnum.gate_entergame,id])
        if (rt[0] == ErrorEnum.ErrorOk){
            this.gameid = id;
        }
        return rt;
    }

    async chat(id: number, msg: string){
        const rt = await this.asendMsg(MsgClientEnum.game_chat,id, msg);
        if (rt[0] == ErrorEnum.ErrorOk){
            // .. nothing            
        }
        return rt;
    }
    
    fillMessage(){
        this.onMessage(MsgClientEnum.c_chat, 
            (id: number, msg: string)=>{
            console.log(`chat from ${id} msg: ${msg}`)   
        })
    }
}