import { ErrorEnum } from "../net/ErrorEnum";

//MsgGameGateEnum.game2gate_info
export enum game2gate_info_error{
    start = ErrorEnum.Max+1,
    Game_already_registered,
    Socket_already_registered,
}

//MsgClientEnum.gate_login
export enum login_error{
    start = ErrorEnum.Max+1,
    logined,
}

//MsgClientEnum.gate_entergame
export enum entergame_error{
    start = ErrorEnum.Max+1,
    not_login,
    already_in_game,
    invalid_playerid,
    game_not_found,
    gameserver_player_in_game,
    gameserver_client_in_game,
}

//MsgClientEnum.gate_exit
export enum exit_error{
    start = ErrorEnum.Max+1,
    entering_game,
    gameserver_not_found_client,
}

//MsgClientEnum.game_chat and game_bcchat
export enum chat_error{
    start = ErrorEnum.Max+1,
    client_not_ingame,
    des_not_ingame,
    bcChat_too_fast,
    bcChat_unknown_channel,
}