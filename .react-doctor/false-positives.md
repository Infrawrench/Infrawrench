# React Doctor false positives

Patterns react-doctor flags that are not real problems in this codebase. The
triage agent drops any diagnostic matching an entry here. Format per entry:

`plugin/rule` — <code shape> — <reason>

Entries that say "after verifying X" require reading the code shape first, not
suppressing on filename alone.

## `react-doctor/only-export-components`

- TanStack Router route files — a file that does `export const Route = createFileRoute(...)({ component: X })` and defines its route component (and optional loaders/`pendingComponent`) locally — the non-component `Route` export is mandated by file-based routing and cannot move to another file. The ecosystem fix is the lint option `allowExportNames: ['Route']`, not extracting the component. After verifying the file exports a `createFileRoute`/`createRootRoute` `Route`.

## `react-doctor/effect-needs-cleanup`

- `useEffect` that subscribes via `window.electronAPI.on(channel, handler)` and returns a cleanup of the form `() => window.electronAPI.offAll(channel)` — `offAll` is this project's matching teardown (it calls `ipcRenderer.removeAllListeners`); the rule just doesn't recognize the custom name. After verifying the effect returns an `offAll(channel)` cleanup.

## `react-doctor/control-has-associated-label`

- Empty table cells: a self-closing `<td />` or `<th ... />` with no children and no interactive content — a layout/spacer cell, not a form control. The rule mis-attributes the row's labeled input to the empty cell. After verifying the flagged node is an empty `<td>`/`<th>`.

## `react-doctor/no-adjust-state-on-prop-change`

- A `useEffect` whose body only defines and calls an `async function load() { … await …; if (!cancelled) setX(…) }` (or `.then(setX)`), with NO state setter run synchronously in the effect body — every setter fires after an `await`. The rule requires the setter to be synchronous; here it kicks off async work whose later callback sets state, which is the rule's own documented FP case. After verifying every setter reachable from the effect body sits after an `await`/in a `.then`/`.finally`.

## `react-doctor/no-danger`

- `dangerouslySetInnerHTML={{ __html: <x>.logoSvg }}` (or `pluginLogoSvg`) rendering a provider logo from the bundled plugin manifest registry — a static, build-time, trusted SVG string, never user/attacker-controllable. Rendering rich SVG genuinely needs raw HTML; there is no escaped-children rewrite. After verifying the `__html` value traces to a plugin `manifest.logoSvg`/registry constant, not request/user input.

## `react-doctor/prefer-tag-over-role`

- A `<div role="listbox">` (or `role="combobox"` input) whose children are interactive `<button role="option">` elements — a custom rich-content listbox. The rule's suggested native `<datalist>`/`<option>` cannot hold interactive button children, so the swap would break the widget. After verifying the listbox children are interactive elements, not plain-text options.
- A `<span role="img">` (or `role="status"` dot) that is an empty element rendering a CSS-only status indicator via `className` (no image content/text). A native `<img>` requires a `src`; the swap would break rendering. After verifying the node has no child content and is styled purely via classes.

## `react-doctor/no-array-index-key` / `react-doctor/no-array-index-as-key`

- `arr.map((item, i) => <… key={i}>)` where `arr` is a strictly append-only log / chat transcript / console output whose rows are primitives or carry no per-item id, and is never reordered or filtered (e.g. `setLog(prev => [...prev, line])`, reset to `[]`). Also: declarative schema/`.split()`-derived lists regenerated wholesale each render. The index IS the stable identity here. After verifying the list is append-only/positionally-stable and the row type has no id field.

## `react-doctor/js-set-map-lookups`

- `<str>.includes(<substr>)` / `<str>.indexOf(<substr>)` where the receiver is a **string** (error message, file-content slice, SSE buffer), i.e. a substring search, not array-membership. Converting to a `Set` is nonsensical. After verifying the receiver is a string, not an array.

## `react-doctor/js-index-maps`

- `coll.find(...)` inside a `for`/loop where the searched array is re-fetched or rebuilt every iteration (e.g. `syncCloudAccountType(...)` per type, `rt.secretExportTemplates` per resource type) and only one key is looked up per iteration — a pre-built index Map cannot be reused across iterations and gains nothing. After verifying the searched array changes per iteration.

## `react-doctor/js-tosorted-immutable`

- `[...someMap.values()].sort(...)` / `[...map.entries()].sort(...)` — the spread materializes a Map iterator into a fresh array (iterators have no `.toSorted`), not a defensive copy, so `.sort()` on that throwaway array is already immutable; `.toSorted()` would only add a second allocation. Separately, this codebase targets ES2022 — `Array.prototype.toSorted` is unavailable and fails typecheck. After verifying the sort target is a freshly-spread iterator.

## `react-doctor/js-cache-property-access`

- A property chain (e.g. `cat.typeDef.id`) that appears multiple times but each occurrence is inside a **separate** callback (`.then`, `.catch`, distinct `.map`) with its own binding, read once per callback — there is nothing to hoist. After verifying the repeated reads are in different closures, not one loop/function body.
