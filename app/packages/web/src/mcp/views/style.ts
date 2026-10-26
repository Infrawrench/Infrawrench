/**
 * The views' stylesheet. Colours come from the host's MCP Apps style
 * variables when it sends them (`--color-text-primary` and the rest), so a
 * view looks like part of the chat it's in, and from Infrawrench's own
 * greys otherwise, light or dark as the host's theme says.
 */
export const VIEW_CSS = `
:root {
  color-scheme: light;
  --iw-bg: var(--color-background-primary, #ffffff);
  --iw-panel: var(--color-background-secondary, #f6f7f9);
  --iw-text: var(--color-text-primary, #111827);
  --iw-dim: var(--color-text-secondary, #4b5563);
  --iw-faint: var(--color-text-tertiary, #9ca3af);
  --iw-line: var(--color-border-primary, #e5e7eb);
  --iw-accent: var(--color-ring-primary, #2563eb);
  --iw-danger: var(--color-text-danger, #dc2626);
  --iw-ok: var(--color-text-success, #059669);
  --iw-radius: var(--border-radius-md, 6px);
  --iw-font: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  --iw-mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --iw-bg: var(--color-background-primary, #111827);
  --iw-panel: var(--color-background-secondary, #1f2937);
  --iw-text: var(--color-text-primary, #f3f4f6);
  --iw-dim: var(--color-text-secondary, #d1d5db);
  --iw-faint: var(--color-text-tertiary, #9ca3af);
  --iw-line: var(--color-border-primary, #374151);
  --iw-accent: var(--color-ring-primary, #60a5fa);
  --iw-danger: var(--color-text-danger, #f87171);
  --iw-ok: var(--color-text-success, #34d399);
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--iw-bg); color: var(--iw-text); }
body { padding: 12px 14px; font: 13px/1.45 var(--iw-font); }
h1 { margin: 0; font-size: 13px; font-weight: 600; }
.sub { color: var(--iw-dim); font-size: 12px; }
.faint { color: var(--iw-faint); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.spread { justify-content: space-between; }
.stack > * + * { margin-top: 10px; }
.big { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.up { color: var(--iw-danger); }
.down { color: var(--iw-ok); }
.error { color: var(--iw-danger); white-space: pre-wrap; }
button, input {
  font: inherit; color: inherit; background: var(--iw-panel);
  border: 1px solid var(--iw-line); border-radius: var(--iw-radius);
}
button { padding: 2px 9px; cursor: pointer; }
button:hover { border-color: var(--iw-faint); }
button[aria-pressed="true"] { border-color: var(--iw-accent); color: var(--iw-accent); }
button:disabled { opacity: 0.5; cursor: default; }
input { padding: 3px 8px; min-width: 0; flex: 1; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--iw-dim); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
svg text { fill: var(--iw-faint); font: 10px var(--iw-font); }
svg .grid { stroke: var(--iw-line); stroke-width: 1; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; font-weight: 500; color: var(--iw-dim); cursor: pointer; user-select: none; }
th, td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--iw-line); vertical-align: top; }
td.mono { font-family: var(--iw-mono); font-size: 11px; }
td.clip { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
tr:hover td { background: var(--iw-panel); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.card { border: 1px solid var(--iw-line); border-radius: var(--iw-radius); padding: 8px 10px; }
`;
