import { fetchHotComments } from "./formatters.js";
import { rebuildDerivedContent } from "./subtitle.js";
import { state } from "./state.js";
import { logWarn } from "./reader.js";

export async function refreshDerivedContent({ refreshComments = false } = {}) {
  if (state.settings?.includeHotCommentsInNote) {
    const shouldFetchComments =
      refreshComments || !Array.isArray(state.clip.hotComments) || state.clip.hotComments.length === 0;
    if (shouldFetchComments) {
      try {
        state.clip.hotComments = await fetchHotComments(20);
      } catch (error) {
        state.clip.hotComments = [];
        logWarn("[BOC] failed to fetch hot comments for note export", error);
      }
    }
  }

  rebuildDerivedContent();
}
