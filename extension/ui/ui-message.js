import { state, uiState } from "../core/state.js";
import { byId } from "../core/runtime.js";

export function setMessage(text) {
  uiState.setMessageText(String(text || ""));
  byId("boc-message").textContent = state.ui.messageText;
}
