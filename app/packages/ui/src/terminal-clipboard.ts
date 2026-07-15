/**
 * Wires clipboard support onto an xterm.js `Terminal` instance:
 *
 *  - Copy on selection — anything the user selects with the mouse is written
 *    to the system clipboard.
 *  - Paste with Cmd+V (macOS) or Ctrl+Shift+V (Linux/Windows). Plain Ctrl+V
 *    is left alone so readline's quoted-insert keeps working.
 *  - Optional image paste — when the clipboard holds an image and no plain
 *    text, `onPasteImage` is invoked with the raw bytes so callers can e.g.
 *    upload it to the remote host and paste the resulting path.
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

export interface TerminalPastedImage {
  data: Uint8Array<ArrayBuffer>;
  mime: string;
}

export interface AttachTerminalClipboardOptions {
  /**
   * Called when the paste shortcut fires and the clipboard holds an image
   * but no plain text. Return the text to paste in its place (e.g. the
   * remote path of an uploaded file), or null to paste nothing.
   */
  onPasteImage?: (image: TerminalPastedImage) => Promise<string | null>;
  /**
   * Platform-native clipboard image reader, tried before the async Clipboard
   * API. Electron renderers need this: `navigator.clipboard.read()` fails
   * its permission check there and rejects, so the desktop app supplies a
   * reader backed by Electron's native clipboard via IPC. Return null when
   * the clipboard holds no image.
   */
  readClipboardImage?: () => Promise<TerminalPastedImage | null>;
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

async function pasteTextFromClipboard(term: ClipboardTerminal): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
  } catch {
    // Clipboard read can fail without user-gesture or permission.
  }
}

async function handlePaste(
  term: ClipboardTerminal,
  options: AttachTerminalClipboardOptions | undefined,
): Promise<void> {
  const onPasteImage = options?.onPasteImage;

  if (onPasteImage && options?.readClipboardImage) {
    try {
      // Text wins when both are present — readText works everywhere,
      // including Electron where clipboard.read() does not.
      const text =
        typeof navigator !== "undefined" && navigator.clipboard?.readText
          ? await navigator.clipboard.readText()
          : "";
      if (text) {
        term.paste(text);
        return;
      }
      const image = await options.readClipboardImage();
      if (image && image.data.length > 0) {
        const pasted = await onPasteImage(image);
        if (pasted) term.paste(pasted);
        return;
      }
      // No text and no image — nothing to paste.
      return;
    } catch {
      // Native reader failed — fall through to the Clipboard API paths.
    }
  }

  if (onPasteImage && typeof navigator !== "undefined" && navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      // Text wins when both are present (e.g. copying from a rich editor) so
      // plain-text paste keeps behaving exactly as before.
      const hasText = items.some((item) => item.types.includes("text/plain"));
      if (!hasText) {
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (!imageType) continue;
          const blob = await item.getType(imageType);
          const data = new Uint8Array(await blob.arrayBuffer());
          const text = await onPasteImage({ data, mime: imageType });
          if (text) term.paste(text);
          return;
        }
      }
    } catch {
      // clipboard.read() unavailable or denied — fall back to text paste.
    }
  }
  await pasteTextFromClipboard(term);
}

export function attachTerminalClipboard(
  term: ClipboardTerminal,
  options?: AttachTerminalClipboardOptions,
): AttachTerminalClipboardHandle {
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
      void handlePaste(term, options);
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

const PASTED_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
};

/** Filename for a clipboard image pasted into a terminal, e.g. `pasted-image-20260714-211530.png`. */
export function pastedImageFilename(mime: string, now: Date): string {
  const ext = PASTED_IMAGE_EXTENSIONS[mime.toLowerCase()] ?? "png";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `pasted-image-${stamp}.${ext}`;
}
