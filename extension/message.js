import { state } from "./state.js";
import { byId } from "./runtime.js";

export function setMessage(text) {
  state.ui.messageText = String(text || "");
  byId("boc-message").textContent = state.ui.messageText;
}
