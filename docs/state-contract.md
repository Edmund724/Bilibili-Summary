# State Encapsulation Contract

This document defines how the extension's shared state is read and written. It lives in
`extension/core/state.ts` and is exported as `state` plus one named object per namespace.

> Since the TypeScript migration, the setter rule below is enforced at compile time:
> business fields are `readonly` on the public namespace types, so a direct write fails
> `tsc --noEmit`. This document remains the human-readable rationale; the types in
> `state.ts` are the machine-checked source of truth.

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
`core/state.ts` runs in the content bundle (`entry/content.ts`, `reader/*`, `subtitle/*`,
`bilibili/*`, `asr/fallback.ts`, …). The service-worker bundle reaches `state.ts` only through
static imports (`shared/logging.ts`, `shared/error-helpers.ts`, `bilibili/gateway.ts`), and its
paths only read defaults (`state.settings?.enableDebugLogs`); no SW path writes business fields.
Loss of this state on page reload is accepted product semantics (state is re-derived from the URL,
Bilibili APIs, or a re-fetch), so nothing here is persisted to `chrome.storage.session`.

Consequences of that attribution:

- MV3 SW termination does not touch any namespace above.
- The only module-level mutable state in the SW graph is the DNR session-rule id ledger in
  `extension/asr/offscreen-bridge.bg.ts`. DNR session rules outlive SW instances while the ledger
  resets on cold start, so the ledger reconciles against
  `chrome.declarativeNetRequest.getSessionRules()` before the first allocation in each SW
  instance — the platform is the source of truth.
- Per-page in-memory registries that hold live promises (for example `activeAsrTranscribes` in
  `asr/fallback.ts`, the "don't cancel on video switch" carrier) belong to the page context and
  are intentionally not persisted; when the context dies the registry dies with it and the
  completed results are recovered from the subtitle cache in `chrome.storage.local`.

## Future note

Business-field writes are now guarded at compile time (see the note at the top). A dev-mode
`Proxy`/assertion helper that hard-fails on a direct write at runtime was considered but
**not** implemented; it would only add coverage for the whitelisted internal fields, and
adding one risks altering their existing direct-write behavior and the bundle.

## Guide for contributors

- When adding a **new business field** to a namespace, add a matching `set<Field>(value)` setter on the
  namespace object, and write that field through the setter everywhere.
- When adding a **new internal timer/host/observer/bound flag** that has no setter and must be written
  directly, add it to the internal-field whitelist list above.
- Keep business writes on setters; keep internal (whitelisted) writes direct.
