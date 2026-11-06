import { ErrorEnum } from "../net/ErrorEnum";

export enum game2gate_info_error{
    start = ErrorEnum.Max+1,
    Game_already_registered,
    Socket_already_registered,
}

export enum login_error{
    start = ErrorEnum.Max+1,
    logined,
}

export enum entergame_error{
    start = ErrorEnum.Max+1,
    not_login,
    already_in_game,
    invalid_playerid,
    game_not_found,
    gameserver_player_in_game,
    gameserver_client_in_game,
}

export enum exit_error{
    start = ErrorEnum.Max+1,
    entering_game,
    gameserver_not_found_client,
}


export enum chat_error{
    start = ErrorEnum.Max+1,
    client_not_ingame,
    des_not_ingame,
    bcChat_too_fast,
    bcChat_unknown_channel,
}