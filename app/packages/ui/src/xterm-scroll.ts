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

export function attachAltBufferScrollHandler(
  term: ScrollableTerminal,
  sendInput: (data: string) => void,
): AttachAltBufferScrollHandle {
  const element = term.element;
  if (!element) return { dispose: () => {} };

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
