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
