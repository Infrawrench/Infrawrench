/**
 * Lets the mouse wheel scroll inside alt-screen TUI apps (k9s, vim, less,
 * htop, …). xterm.js's built-in wheel handler scrolls the scrollback buffer
 * in the *normal* buffer, but does nothing when an app has switched to the
 * alternate buffer. We synthesize arrow-key sequences so the app receives a
 * scroll-shaped input it can react to.
 *
 * Typed loosely so the `@infrawrench/ui` package does not need a hard
 * dependency on `@xterm/xterm` — callers pass their real `Terminal`.
 */

export interface ScrollableTerminal {
  element: HTMLElement | undefined;
  buffer: { active: { type: string } };
  /** xterm.js Terminal.modes — used to detect app-side mouse tracking. */
  modes?: { mouseTrackingMode: string };
}

export interface AttachAltBufferScrollHandle {
  dispose: () => void;
}

export interface AltBufferScrollOptions {
  /**
   * Key sequences synthesized per wheel tick. "arrows" (default) suits
   * cursor-driven TUIs (vim, k9s, less). "page" sends PageUp/PageDown, for
   * apps where arrow keys move the cursor or edit history instead of
   * scrolling — e.g. coding-agent prompts (Claude Code, Codex).
   */
  wheelKeys?: "arrows" | "page";
}

export function attachAltBufferScrollHandler(
  term: ScrollableTerminal,
  sendInput: (data: string) => void,
  options?: AltBufferScrollOptions,
): AttachAltBufferScrollHandle {
  const element = term.element;
  if (!element) return { dispose: () => {} };

  const pageMode = options?.wheelKeys === "page";
  // Page mode accumulates wheel movement and emits one PageUp/PageDown per
  // LINES_PER_PAGE_KEY lines — a page key scrolls far more than an arrow, so
  // 1:1 with wheel ticks would be uncontrollable (especially on trackpads).
  const LINES_PER_PAGE_KEY = 3;
  let pageCarry = 0;

  const handler = (event: WheelEvent) => {
    if (term.buffer.active.type !== "alternate") return;
    if (event.deltaY === 0) return;
    // When the app has enabled mouse tracking, xterm already converts wheel
    // events into mouse reports the app scrolls with — synthesizing keys on
    // top would double-scroll (or, in agent prompts, walk input history).
    if (term.modes && term.modes.mouseTrackingMode !== "none") return;

    // deltaMode 0 = pixels (trackpads), 1 = lines (most mice), 2 = pages.
    const rawLines = event.deltaMode === 0 ? Math.abs(event.deltaY) / 16 : Math.abs(event.deltaY);
    const lines = Math.min(10, Math.max(1, Math.round(rawLines)));

    if (pageMode) {
      const signedLines = event.deltaY < 0 ? -lines : lines;
      // Direction change discards leftover momentum from the previous one.
      if (Math.sign(pageCarry) !== 0 && Math.sign(signedLines) !== Math.sign(pageCarry)) {
        pageCarry = 0;
      }
      pageCarry += signedLines;
      const keys = Math.trunc(pageCarry / LINES_PER_PAGE_KEY);
      if (keys !== 0) {
        pageCarry -= keys * LINES_PER_PAGE_KEY;
        const code = keys < 0 ? "\x1b[5~" : "\x1b[6~"; // PageUp / PageDown
        sendInput(code.repeat(Math.min(3, Math.abs(keys))));
      }
      event.preventDefault();
      return;
    }

    const code = event.deltaY < 0 ? "\x1bOA" : "\x1bOB"; // up / down arrow
    sendInput(code.repeat(lines));
    event.preventDefault();
  };

  element.addEventListener("wheel", handler, { passive: false });

  return {
    dispose: () => {
      element.removeEventListener("wheel", handler);
    },
  };
}
