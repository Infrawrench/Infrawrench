/**
 * The playback terminal contract.
 *
 * This package stays free of an xterm dependency (see `xterm-options.ts` for
 * the same stance), so the player owns *when* bytes are written and the host
 * owns *what writes them*. Web and desktop each hand in an xterm-backed
 * implementation; the mobile app hands in nothing and gets the metadata list
 * without a player, which is the honest shape for a phone.
 *
 * Duck-typed against the subset of xterm's `Terminal` the player needs, so a
 * host adapter is a dozen lines rather than a wrapper component.
 */
export interface PlaybackTerminal {
  /** Write raw terminal bytes (already decoded to a string). */
  write(data: string): void;
  /** Wipe the screen and scrollback — the first half of every seek. */
  reset(): void;
  /** Apply an `"r"` (resize) event from the cast. */
  resize(cols: number, rows: number): void;
  /** Tear down; the container element is the caller's to remove. */
  dispose(): void;
}

/**
 * Create a terminal inside `container`, sized to the recording's geometry.
 *
 * The player calls this once per mounted recording and disposes it on unmount.
 * `cols`/`rows` come from the cast header, so playback starts at the geometry
 * the session was actually recorded at rather than whatever the viewport
 * happens to be — a session recorded at 200 columns must not reflow into 80,
 * because reflowed output is not what the operator saw.
 */
export type MountPlaybackTerminal = (
  container: HTMLElement,
  geometry: { cols: number; rows: number },
) => PlaybackTerminal;
