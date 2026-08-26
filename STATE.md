# State Encapsulation Contract

This document defines how the extension's shared state is read and written. It lives in
`extension/state.js` and is exported as `state` plus one named object per namespace.

## Namespaces

There are three namespaces, each exposed two ways (they are the **same** object):

| Namespace       | Structured alias  | Business object   |
| --------------- | ----------------- | ----------------- |
| `clipState`     | `state.clip`       | clip/subtitle state |
| `playerAiState` | `state.playerAi`   | player-AI UI state |
| `uiState`       | `state.ui`         | UI/chrome state    |

The reader namespace is exposed **only** as `state.reader` (the standalone `readerState` alias was
removed in issue 07):

| Namespace | Access path    | Business object |
| --------- | -------------- | --------------- |
| reader    | `state.reader` | reader state    |

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
readingVideoEl                 readingPlayerRetryTimer         readingMiniDismissTimer
readingDocumentClickBound      readingManualScrollPauseUntil   readingProgrammaticScrollUntil
```

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
