// 先随便谢谢

export enum MsgGameGateEnum{
    game2gate_info = 1000,  // game通知gate 我的id
    gate2game_entergame,    // gate通知game 进入游戏 
    gate2game_exit,         // gate通知game 退出
    gate2game_disconnect,   // gate通知game 断线了
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
