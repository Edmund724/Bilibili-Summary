# 03: Deduplicate background.js formatters by importing formatters.js

**What to build:** Replace the inline copies of `normalizeChapters`, `subtitlePriority`, `formatCompactTimestamp`, `mapSubtitleTracks`, `normalizeSubtitleUrl`, `buildSubtitleInfoRequests`, and other formatter functions in `background.js` with direct imports from `extension/formatters.js`. `background.js` is already an ES module (`"type": "module"` in manifest), so cross-file imports are supported.

**Blocked by:** #02

**Status:** ready-for-agent

- [x] Add `import { ... } from "./formatters.js"` for every duplicated function in `background.js`
- [x] Delete the inline implementations from `background.js`
- [x] Verify `background.js` message handlers (`fetch-json`, `ai-sidepanel-*`, etc.) still return correct results
- [x] Verify no behavioral drift in subtitle track sorting, chapter normalization, or URL handling

## Comments
Implemented by directly editing `extension/background.js` after the parallel sub-agent for #03 stalled.

Changes:
- Added imports from `./formatters.js` for: `normalizeChapters`, `subtitlePriority`, `formatCompactTimestamp`, `mapSubtitleTracks`, `normalizeSubtitleUrl`, `buildSubtitleInfoRequests`, `normalizeSubtitleUrlForCache`, `pickPreferredSubtitle` (aliased as `pickPreferredSubtitleTrack`), `mapChaptersFromPlayerData`, `normalizeChapterTime`, `normalizeSubtitleTracks`
- Removed all inline implementations of the above functions from `background.js`
- The `formatters.js` versions are strictly more correct (e.g. `normalizeSubtitleUrl` handles `http://`/`https://`/root-relative URLs, `normalizeSubtitleTracks` adds `lanDoc`/`lan` and `id` tiebreak sorting)
- Also migrated `extension/formatters.js` to use `state.clip.aid` instead of `state.aid` for consistency with the structured state namespace introduced in #05 / bundled in #06
- Regenerated `extension/content-classic.js` via `node scripts/build-content-classic.js`
- Verified `node --check` passes on `background.js` and `formatters.js`
