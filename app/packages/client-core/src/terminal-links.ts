/**
 * Validation for links clicked in a terminal.
 *
 * Terminal output is remote-controlled text: whatever host you are connected
 * to decides what appears in the buffer, so a "link" is untrusted input. This
 * is the single gate every platform runs it through before anything opens —
 * web (`window.open`), desktop (Electron `shell.openExternal`), and mobile
 * (`Linking.openURL`, re-validated on the React Native side after the tap
 * crosses the WebView bridge).
 *
 * Lives in client-core rather than `@infrawrench/ui` because mobile cannot
 * import the UI package; `@infrawrench/ui` re-exports it, and owns the
 * xterm-facing wiring built on top.
 */

/**
 * Schemes a terminal link may use. Deliberately not extensible: every other
 * scheme either does nothing useful in a browser or is an escape hatch into
 * the app (`javascript:`), the filesystem (`file:`), or an inline payload
 * (`data:`).
 */
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validate a URL detected in terminal output and return the exact string to
 * open, or null when it must not be opened.
 *
 * Returns the parsed `href` rather than the raw match, so what opens is what
 * was validated — there is no second, differing parse downstream.
 */
export function normalizeTerminalLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Something this long is not a link anyone meant to tap, and it is a cheap
  // way to make the parser do pointless work.
  if (trimmed.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!ALLOWED_LINK_PROTOCOLS.has(parsed.protocol)) return null;
  return parsed.href;
}
