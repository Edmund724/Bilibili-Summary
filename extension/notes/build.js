import { fetchHotComments } from "../bilibili/bili-api.js";
import { rebuildDerivedContent } from "../subtitle/core.js";
import { state, clipState } from "../core/state.js";
import { logWarn } from "../reader/shell.js";

export async function refreshDerivedContent({ refreshComments = false } = {}) {
  if (state.settings?.includeHotCommentsInNote) {
    const shouldFetchComments =
      refreshComments || !Array.isArray(state.clip.hotComments) || state.clip.hotComments.length === 0;
    if (shouldFetchComments) {
      try {
        clipState.setHotComments(await fetchHotComments(20));
      } catch (error) {
        clipState.setHotComments([]);
        logWarn("[BOC] failed to fetch hot comments for note export", error);
      }
    }
  }

  rebuildDerivedContent();
}
