export interface TerminalThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

export function getTerminalTheme(): TerminalThemeColors {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--color-terminal-bg", "#0d0d0d"),
    foreground: v("--color-terminal-fg", "#d4d4d4"),
    cursor: v("--color-terminal-cursor", "#d4d4d4"),
    cursorAccent: v("--color-terminal-cursor-accent", "#0d0d0d"),
    selectionBackground: v("--color-terminal-selection", "#264f78"),
  };
}
