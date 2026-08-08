import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { getXtermTerminalOptions, type MountPlaybackTerminal } from "@infrawrench/ui";

/**
 * xterm.js behind the session-recording player's terminal contract.
 *
 * Lives in the host rather than in `@infrawrench/ui` because that package
 * stays free of an xterm dependency (see `xterm-options.ts`) — the player owns
 * the clock, the host owns the screen. The desktop app has its own copy of
 * this file for the same reason its terminal components are not shared.
 *
 * Two departures from a live terminal, both because this one is a replay:
 *
 * - **No fit addon.** The recording's own geometry is authoritative; reflowing
 *   a 200-column session into an 80-column panel would render something the
 *   operator never saw. The container scrolls instead.
 * - **No cursor blink.** A blinking cursor on a paused recording reads as a
 *   live session waiting for input, which is precisely the wrong impression.
 */
export const mountPlaybackTerminal: MountPlaybackTerminal = (container, geometry) => {
  const term = new Terminal({
    ...getXtermTerminalOptions(),
    cols: geometry.cols,
    rows: geometry.rows,
    cursorBlink: false,
    // A replay has no scrollback of its own to hunt through — seeking is the
    // scrollback — and a buffer sized for a live session costs memory per
    // recording opened.
    scrollback: 1000,
    disableStdin: true,
  });
  term.open(container);

  return {
    write: (data) => term.write(data),
    // `reset()` rather than `clear()`: seeking has to drop the scrollback and
    // every mode the earlier bytes set (alt buffer, wrap, colours), or the
    // replay renders into a terminal still carrying the state it is meant to
    // be rebuilding.
    reset: () => term.reset(),
    resize: (cols, rows) => term.resize(cols, rows),
    dispose: () => term.dispose(),
  };
};
