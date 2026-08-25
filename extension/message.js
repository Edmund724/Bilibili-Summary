import { state, uiState } from "./state.js";
import { byId } from "./runtime.js";

export function setMessage(text) {
  uiState.setMessageText(String(text || ""));
  byId("boc-message").textContent = state.ui.messageText;
}
