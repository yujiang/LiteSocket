// 先随便谢谢

export enum MsgGameGateEnum{
    game2gate_info = 1000, // 通知gate我的id
    gate2game_entergame,    
    gate2game_exit,    
    gate2game_clientdisconnect,    
}

export enum MsgClientEnum{
    gate_login = 2000,
    gate_entergame,
    game_chat,    
    gate_exit,
    c_chat,
}
