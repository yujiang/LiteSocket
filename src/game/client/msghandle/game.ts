import type { GameClient } from "../GameClient";
import { bindChatMessage } from "./game_chat";

export function bindGameMessage(client: GameClient) {
    bindChatMessage(client);
}
