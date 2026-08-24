import { state } from "./state.js";
import { byId } from "./router.js";

export function setMessage(text) {
  state.messageText = String(text || "");
  byId("boc-message").textContent = state.messageText;
}
