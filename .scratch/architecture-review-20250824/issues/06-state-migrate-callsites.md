# 06: Migrate all call sites to structured state namespace

**What to build:** Update every module that reads or writes `state` to use the structured namespace (`state.reader.*`, `state.clip.*`, etc.) instead of the flat Proxy. This is the "migrate" phase. Keep both access patterns working; do not delete the old Proxy yet.

**Blocked by:** #05

**Status:** ready-for-agent

- [x] Migrate `content.js`, `content-classic.js`, `reader.js`, `panel.js`, `messages.js`, `player-ai.js`, `router.js`, `subtitle.js`, `message.js`, `sidepanel.js`, `popup.js`, `options.js`, `background.js`
- [x] Verify reader view, subtitle fetch, AI sidepanel, popup, options page, and player AI button still function
- [ ] Add a lint or test rule that flags new flat-namespace writes (optional)

## Comments
Implemented via parallel sub-agent + direct edits.

- The #06 sub-agent migrated all 12 target files to the structured state namespace (`state.reader.*`, `state.clip.*`, `state.playerAi.*`, `state.ui.*`), keeping `state.settings` and `state.normalPageStateObserver` flat.
- `background.js` was excluded from the sub-agent to avoid conflicts with #03, but it already had no flat `state.*` accesses beyond `state.settings`, so no migration was needed there.
- `content.js`, `sidepanel.js`, `popup.js`, and `options.js` had no `state.*` accesses to migrate.
- `formatters.js` was also updated to use `state.clip.aid` instead of `state.aid` for consistency.
- `extension/content-classic.js` was regenerated via `node scripts/build-content-classic.js` to incorporate the latest source changes.
- All modified files pass `node --check`.
