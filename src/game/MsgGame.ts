// 先随便写点消息

export enum MsgGameGateEnum{
    start = 1000,
    game2gate_info = start,  // 我的id
    gate2game_entergame,    // 进入游戏 
    gate2game_exit,         // 退出
    gate2game_disconnect,   // 断线了
    game2gate_exit,         // game主动通知gate退出，可能是gm kickoff等
    end,
}

export enum MsgClientEnum{
    start = 2000,
    gate_login = start,
    gate_entergame,
    game_chat,    
    gate_exit,
    c_chat,
    end,
}


export function getGameMsgName(id: number): string {
    // console.log('getMsgName:', id);
    if (id >= MsgGameGateEnum.start && id < MsgGameGateEnum.end) {
        return MsgGameGateEnum[id];
    }
    if (id >= MsgClientEnum.start && id < MsgClientEnum.end) {
        return MsgClientEnum[id];
    }
}
