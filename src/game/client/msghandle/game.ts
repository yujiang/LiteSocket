import { IOClient } from "../../../client";
import type { GameClient } from "../GameClient";
import { GlobalClient } from "../GlobalClient";
import { bindChatMessage } from "./game_chat";

export function bindGameMessage(client: IOClient, context: GlobalClient) {
    bindChatMessage(client, context);
}
