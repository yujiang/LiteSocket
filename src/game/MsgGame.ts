// 先随便写点消息

export enum MsgGameGateEnum{
    game2gate_info = 1000,  // 我的id
    gate2game_entergame,    // 进入游戏 
    gate2game_exit,         // 退出
    gate2game_disconnect,   // 断线了
    game2gate_exit,         // game主动通知gate退出，可能是gm kickoff等
    Max,
}

export enum MsgClientEnum{
    gate_login = 2000,
    gate_entergame,
    game_chat,    
    gate_exit,
    c_chat,
    Max,
}
