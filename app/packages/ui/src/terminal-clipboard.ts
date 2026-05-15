/**
 * Wires clipboard support onto an xterm.js `Terminal` instance:
 *
 *  - Copy on selection — anything the user selects with the mouse is written
 *    to the system clipboard.
 *  - Paste with Cmd+V (macOS) or Ctrl+Shift+V (Linux/Windows). Plain Ctrl+V
 *    is left alone so readline's quoted-insert keeps working.
 *
 * Typed loosely so the `@infrawrench/ui` package does not need a hard
 * dependency on `@xterm/xterm` — callers pass their real `Terminal`.
 */

export interface ClipboardTerminal {
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  onSelectionChange(handler: () => void): { dispose: () => void };
  getSelection(): string;
  paste(data: string): void;
}

export interface AttachTerminalClipboardHandle {
  dispose: () => void;
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  const platform = (navigator as Navigator & { platform?: string }).platform ?? "";
  return /Mac|iPod|iPhone|iPad/.test(platform) || /Mac OS X/.test(ua);
}

export function attachTerminalClipboard(term: ClipboardTerminal): AttachTerminalClipboardHandle {
  const isMac = isMacPlatform();

  const selectionSub = term.onSelectionChange(() => {
    const selection = term.getSelection();
    if (!selection) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(selection).catch(() => {
      // Permission denied or no secure context — silently ignore; the user
      // can still use the browser's built-in copy via context menu.
    });
  });

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;

    const key = event.key.toLowerCase();
    const isPaste = isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && key === "v"
      : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && key === "v";

    if (isPaste) {
      event.preventDefault();
      if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {
            // Clipboard read can fail without user-gesture or permission.
          });
      }
      return false;
    }

    return true;
  });

  return {
    dispose: () => {
      selectionSub.dispose();
    },
  };
}
