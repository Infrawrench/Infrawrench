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
export function getXtermTerminalOptions() {
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
    scrollback: 10000,
  };
}
