/**
 * Clickable links in terminals.
 *
 * Two independent things produce a link in an xterm terminal, and both route
 * through here so they cannot diverge:
 *
 *  - **Plain text URLs** the remote program printed (`t3 connect link` and
 *    `gh auth login` both do this). Detected by `@xterm/addon-web-links`,
 *    which each platform loads — the addon does the buffer scanning and
 *    line-wrap handling; this module decides what happens on click.
 *  - **OSC 8 hyperlinks**, where the program marks a range as a link with an
 *    escape sequence. xterm handles those natively via the `linkHandler`
 *    terminal option.
 *
 * The URL comes from the remote host, which means it is untrusted input: a
 * program can print any text it likes. So the scheme is allow-listed to
 * http/https before anything opens, and opening always goes to the user's
 * real browser rather than anywhere inside the app. `javascript:`, `data:`,
 * `file:` and friends are refused outright — there is no legitimate reason
 * for a terminal to hand one of those to the app shell.
 *
 * Typed loosely so `@infrawrench/ui` does not need a hard dependency on
 * `@xterm/xterm` — same approach as `terminal-clipboard.ts`.
 */

import { normalizeTerminalLinkUrl } from "@infrawrench/client-core";

// Re-exported so terminal callers have one import; the validator itself
// lives in client-core because mobile cannot import this package.
export { normalizeTerminalLinkUrl };

export interface TerminalLinkHandlerOptions {
  /**
   * Opens the URL in the user's real browser. Desktop routes this through
   * the main process (`open_external_url`); web uses a new tab.
   */
  openExternal: (url: string) => void;
  /** Called when a link is refused, so the caller can surface a reason. */
  onRejected?: (raw: string) => void;
}

/**
 * xterm's `ILinkHandler` shape, for the terminal's `linkHandler` option
 * (OSC 8 hyperlinks). Structural rather than imported, per the note above.
 */
export interface TerminalLinkHandler {
  activate(event: MouseEvent | undefined, text: string): void;
  /**
   * xterm asks before activating a non-http scheme. Always false: the same
   * allow-list is enforced in `activate`, but refusing here means xterm does
   * not even render such a range as a link.
   */
  allowNonHttpProtocols: false;
}

/**
 * Build the click behaviour shared by OSC 8 links and detected plain-text
 * URLs. Pass the result as the terminal's `linkHandler`, and pass its
 * `activate` to the web-links addon.
 */
export function createTerminalLinkHandler(
  options: TerminalLinkHandlerOptions,
): TerminalLinkHandler {
  return {
    activate(_event, text) {
      const url = normalizeTerminalLinkUrl(text);
      if (!url) {
        options.onRejected?.(text);
        return;
      }
      options.openExternal(url);
    },
    allowNonHttpProtocols: false,
  };
}

/**
 * Open a URL in a new browser tab from a web renderer.
 *
 * `noopener,noreferrer` matters here: without `noopener` the opened page gets
 * a `window.opener` handle back into the app, which is a navigation hijack
 * primitive handed to a page whose address the remote host chose.
 */
export function openTerminalLinkInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
