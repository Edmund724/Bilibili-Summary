# State Encapsulation Contract

This document defines how the extension's shared state is read and written. It lives in
`extension/core/state.js` and is exported as `state` plus one named object per namespace.

## Namespaces

There are four namespaces, each exposed two ways (they are the **same** object):

| Namespace       | Structured alias  | Business object   |
| --------------- | ----------------- | ----------------- |
| `readerState`   | `state.reader`    | reader state      |
| `clipState`     | `state.clip`      | clip/subtitle state |
| `playerAiState` | `state.playerAi`  | player-AI UI state |
| `uiState`       | `state.ui`        | UI/chrome state   |

The module exports `state, clipState, playerAiState, uiState`; the short aliases (`state.reader`,
`state.clip`, …) live on the `state` target itself. Both spellings of each namespace are the same
object — prefer the `xxxState` spelling in new code.

Plus a single flat settings object:

- `state.settings` — current settings (a copy of `DEFAULT_SETTINGS`).
- `state.setSettings(next)` — replace `settings` with `next`.

## The rule

Business fields are written **only** through their `set<Field>(value)` method. Do **not** write
`state.<namespace>.<businessField> = value` directly.

```js
// correct
state.reader.setTheme("dark");
clipState.setTitle("...");
uiState.setStatusText("...");
playerAiState.setSubmitting(true);

// incorrect — bypasses the setter contract
state.reader.readingTheme = "dark";
```

Because `state.reader` is the reader namespace object, reading `state.reader.<field>` on the
**right-hand side** of a setter call is fine and equivalent:

```js
state.reader.setSettingsExpanded(!state.reader.readingSettingsExpanded);
```

## Internal-field whitelist

The following `state.reader` fields have **no setter** and are intentionally written directly. They are
internal DOM/timer/observer/bound-state bookkeeping, not business fields. Do **not** convert these to
setters, and do **not** add copies of them to the setter table:

```
readingVideoEl
readingDocumentClickBound
```

## Context attribution (runtime volatility)

The four namespaces above form a **content-script (page-context) singleton**: every importer of
`core/state.js` runs in the content bundle (`entry/content.js`, `reader/*`, `subtitle/*`,
`bilibili/*`, `asr/fallback.js`, …). The service-worker bundle reaches `state.js` only through
static imports (`shared/logging.js`, `shared/error-helpers.js`, `bilibili/gateway.js`), and its
paths only read defaults (`state.settings?.enableDebugLogs`); no SW path writes business fields.
Loss of this state on page reload is accepted product semantics (state is re-derived from the URL,
Bilibili APIs, or a re-fetch), so nothing here is persisted to `chrome.storage.session`.

Consequences of that attribution:

- MV3 SW termination does not touch any namespace above.
- The only module-level mutable state in the SW graph is the DNR session-rule id ledger in
  `extension/asr/offscreen-bridge.bg.js`. DNR session rules outlive SW instances while the ledger
  resets on cold start, so the ledger reconciles against
  `chrome.declarativeNetRequest.getSessionRules()` before the first allocation in each SW
  instance — the platform is the source of truth.
- Per-page in-memory registries that hold live promises (for example `activeAsrTranscribes` in
  `asr/fallback.js`, the "don't cancel on video switch" carrier) belong to the page context and
  are intentionally not persisted; when the context dies the registry dies with it and the
  completed results are recovered from the subtitle cache in `chrome.storage.local`.

## Future note

A dev-mode `Proxy`/assertion helper that hard-fails on a direct business-field write was considered but
**not** implemented. Adding one risks altering the existing direct-write behavior of the internal
whitelist fields and the bundle. Guarding direct writes is left as a possible follow-up.

## Guide for contributors

- When adding a **new business field** to a namespace, add a matching `set<Field>(value)` setter on the
  namespace object, and write that field through the setter everywhere.
- When adding a **new internal timer/host/observer/bound flag** that has no setter and must be written
  directly, add it to the internal-field whitelist list above.
- Keep business writes on setters; keep internal (whitelisted) writes direct.
