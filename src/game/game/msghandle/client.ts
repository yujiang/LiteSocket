import { GameGate } from "../GameGate";
import { GlobalContext } from "../GlobalContext";
import { bindChatMessage } from "./client_chat";

export function bindClientMessage(gate: GameGate, context: GlobalContext) {
    bindChatMessage(gate, context);
}
