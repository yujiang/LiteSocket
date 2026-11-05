import { GameGate } from "../GameGate";
import { GlobalGame } from "../GlobalGame";
import { bindChatMessage } from "./client_chat";

export function bindClientMessage(gate: GameGate, context: GlobalGame) {
    bindChatMessage(gate, context);
}
