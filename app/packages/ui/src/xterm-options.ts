import { getTerminalTheme } from "./terminal-theme.js";

/**
 * Common xterm.js `Terminal` constructor options used by every terminal in
 * the app (desktop SSH/k8s-exec/k9s and the web equivalents). The
 * background/foreground/cursor colours are pulled from CSS variables via
 * `getTerminalTheme` so the terminal matches the active app theme; the 16
 * ANSI palette colours are hard-coded to a tuned VS Code-like palette.
 *
 * Re-exported as a function (not a constant) because it reads computed CSS
 * vars from the live document at call time.
 *
 * The shape mirrors `ITerminalOptions` from `@xterm/xterm` but we don't
 * import that type here to keep this package free of an xterm dependency.
 */
export interface XtermTerminalOptionOverrides {
  /**
   * Coding-agent tabs (Claude Code, Codex) manage their own scrolling
   * in-app, so xterm's scrollback buffer — and the scrollbar it draws — are
   * pure noise there. 0 disables scrollback entirely.
   */
  scrollback?: number;
}

export function getXtermTerminalOptions(overrides?: XtermTerminalOptionOverrides) {
  const termTheme = getTerminalTheme();
  return {
    theme: {
      ...termTheme,
      black: "#1e1e1e",
      red: "#f44747",
      green: "#4ec9b0",
      yellow: "#dcdcaa",
      blue: "#569cd6",
      magenta: "#c586c0",
      cyan: "#9cdcfe",
      white: "#d4d4d4",
      brightBlack: "#808080",
      brightRed: "#f44747",
      brightGreen: "#4ec9b0",
      brightYellow: "#dcdcaa",
      brightBlue: "#569cd6",
      brightMagenta: "#c586c0",
      brightCyan: "#9cdcfe",
      brightWhite: "#ffffff",
    },
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: "block" as const,
    allowTransparency: true,
    convertEol: false,
    scrollback: overrides?.scrollback ?? 10000,
    // Without this xterm renders only to its canvas/DOM row layer and the
    // session is invisible to NVDA, VoiceOver and Orca — which, in an app
    // whose primary surface is SSH and `kubectl exec`, means the product
    // does not work at all for a screen reader user.
    //
    // On unconditionally rather than behind a preference. The cost is
    // bounded and small: xterm 5.x builds its accessibility tree lazily,
    // one node per *visible viewport row* (`for (let i = 0; i <
    // this._terminal.rows; i++)` in `AccessibilityManager`), so it is O(rows)
    // and independent of the 10 000-line scrollback above; refreshes are
    // driven by `onRender` through a `TimeBasedDebouncer` rather than a
    // per-frame loop (the 60fps figure in xterm's wiki design document
    // predates the 5.0 rewrite); and live-region announcements are capped at
    // `MAX_ROWS_TO_READ = 20` lines, after which xterm announces
    // "too much output" instead, so a `yes` flood cannot turn into unbounded
    // announcement work. A preference would also have to default to off,
    // which is the present defect restated — a screen reader user cannot
    // discover a setting in a UI they cannot read.
    screenReaderMode: true,
  };
}

/**
 * Describes which session a terminal mount point is showing, so the mount
 * point can carry an accessible name that says *which* terminal it is.
 */
export type TerminalDescription =
  | { kind: "ssh"; host: string; username?: string | undefined }
  | {
      kind: "k8s-exec";
      namespace: string;
      podName: string;
      containerName?: string | undefined;
    }
  | { kind: "k9s"; namespace?: string | undefined }
  | { kind: "playback" };

/**
 * The accessible name for a terminal mount point. A screen reader user lands
 * on the terminal with no visual context, so the name has to identify the
 * host, pod or container rather than just say "terminal".
 */
export function getTerminalAccessibleName(target: TerminalDescription): string {
  switch (target.kind) {
    case "ssh":
      return `SSH terminal, ${target.username ? `${target.username}@${target.host}` : target.host}`;
    case "k8s-exec": {
      const container = target.containerName ? `, container ${target.containerName}` : "";
      return `Kubernetes exec terminal, pod ${target.podName} in namespace ${target.namespace}${container}`;
    }
    case "k9s":
      return target.namespace
        ? `k9s terminal, namespace ${target.namespace}`
        : "k9s terminal, all namespaces";
    case "playback":
      return "Session recording playback terminal";
  }
}

/**
 * Props for the `<div>` xterm is mounted into.
 *
 * `role="application"` is what makes an *interactive* terminal usable at all
 * under a screen reader: NVDA and JAWS otherwise stay in browse mode and
 * swallow the keystrokes meant for the remote shell. It is paired with an
 * accessible name because an unlabelled application region announces as
 * nothing at all.
 *
 * The recording player is the deliberate exception. It sets `disableStdin`,
 * so there are no keystrokes to pass through, and forcing focus mode there
 * would take away the arrow-key navigation that is the only way to read a
 * replay — `role="group"` keeps the buffer browsable.
 */
export function getTerminalContainerProps(target: TerminalDescription): {
  role: "application" | "group";
  "aria-label": string;
} {
  return {
    role: target.kind === "playback" ? "group" : "application",
    "aria-label": getTerminalAccessibleName(target),
  };
}

/**
 * Hide the xterm viewport's scrollbar inside `container`. Used for
 * coding-agent tabs where scrollback is disabled and the tool scrolls
 * in-app — without this an empty scrollbar gutter still renders.
 * Call after `terminal.open(container)`.
 */
export function hideXtermScrollbar(container: HTMLElement): void {
  const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
  if (viewport) {
    viewport.style.scrollbarWidth = "none";
    viewport.style.overflowY = "hidden";
  }
}
