import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachTerminalClipboard,
  pastedImageFilename,
  type ClipboardTerminal,
} from "../terminal-clipboard";

function makeTerm() {
  let selectionHandler: (() => void) | undefined;
  let keyHandler: ((e: KeyboardEvent) => boolean) | undefined;
  const disposed = { value: false };
  const term: ClipboardTerminal & {
    fireSelection: () => void;
    fireKey: (e: Partial<KeyboardEvent>) => boolean | undefined;
  } = {
    attachCustomKeyEventHandler: (h) => {
      keyHandler = h;
    },
    onSelectionChange: (h) => {
      selectionHandler = h;
      return {
        dispose: () => {
          disposed.value = true;
        },
      };
    },
    getSelection: () => "selected-text",
    paste: vi.fn(),
    fireSelection: () => selectionHandler?.(),
    fireKey: (e) => keyHandler?.(e as KeyboardEvent),
  };
  return { term, disposed };
}

describe("attachTerminalClipboard", () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      platform: "MacIntel",
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue("pasted"),
      },
    });
  });

  afterEach(() => {
    vi.stubGlobal("navigator", originalNavigator);
    vi.restoreAllMocks();
  });

  it("copies the selection to the clipboard on selection change", () => {
    const { term } = makeTerm();
    attachTerminalClipboard(term);
    term.fireSelection();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("selected-text");
  });

  it("ignores empty selection", () => {
    const { term } = makeTerm();
    term.getSelection = () => "";
    attachTerminalClipboard(term);
    term.fireSelection();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("pastes on Cmd+V on mac and prevents default", async () => {
    const { term } = makeTerm();
    attachTerminalClipboard(term);
    const preventDefault = vi.fn();
    const result = term.fireKey({
      type: "keydown",
      key: "v",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      preventDefault,
    });
    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(term.paste).toHaveBeenCalledWith("pasted");
  });

  it("lets plain Ctrl+V pass through on mac (returns true)", () => {
    const { term } = makeTerm();
    attachTerminalClipboard(term);
    const result = term.fireKey({
      type: "keydown",
      key: "v",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      preventDefault: vi.fn(),
    });
    expect(result).toBe(true);
  });

  it("ignores non-keydown events", () => {
    const { term } = makeTerm();
    attachTerminalClipboard(term);
    expect(term.fireKey({ type: "keyup", key: "v", metaKey: true, preventDefault: vi.fn() })).toBe(
      true,
    );
  });

  it("dispose unsubscribes selection handler", () => {
    const { term, disposed } = makeTerm();
    const handle = attachTerminalClipboard(term);
    handle.dispose();
    expect(disposed.value).toBe(true);
  });

  function makeClipboardItem(types: string[], imageBytes = new Uint8Array([1, 2, 3])) {
    return {
      types,
      getType: vi.fn().mockResolvedValue({
        arrayBuffer: () => Promise.resolve(imageBytes.buffer),
      }),
    };
  }

  async function flush() {
    // Let the chained clipboard promises settle.
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  const macPasteKey = {
    type: "keydown",
    key: "v",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    preventDefault: vi.fn(),
  } as const;

  it("uploads a clipboard image via onPasteImage and pastes the returned path", async () => {
    const read = vi.fn().mockResolvedValue([makeClipboardItem(["image/png"])]);
    (navigator.clipboard as unknown as { read: typeof read }).read = read;
    const onPasteImage = vi.fn().mockResolvedValue("/tmp/pasted-image.png");
    const { term } = makeTerm();
    attachTerminalClipboard(term, { onPasteImage });
    term.fireKey(macPasteKey);
    await flush();
    expect(onPasteImage).toHaveBeenCalledWith({
      data: new Uint8Array([1, 2, 3]),
      mime: "image/png",
    });
    expect(term.paste).toHaveBeenCalledWith("/tmp/pasted-image.png");
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });

  it("prefers text when the clipboard holds both text and an image", async () => {
    const read = vi.fn().mockResolvedValue([makeClipboardItem(["text/plain", "image/png"])]);
    (navigator.clipboard as unknown as { read: typeof read }).read = read;
    const onPasteImage = vi.fn();
    const { term } = makeTerm();
    attachTerminalClipboard(term, { onPasteImage });
    term.fireKey(macPasteKey);
    await flush();
    expect(onPasteImage).not.toHaveBeenCalled();
    expect(term.paste).toHaveBeenCalledWith("pasted");
  });

  it("pastes nothing when onPasteImage returns null", async () => {
    const read = vi.fn().mockResolvedValue([makeClipboardItem(["image/png"])]);
    (navigator.clipboard as unknown as { read: typeof read }).read = read;
    const onPasteImage = vi.fn().mockResolvedValue(null);
    const { term } = makeTerm();
    attachTerminalClipboard(term, { onPasteImage });
    term.fireKey(macPasteKey);
    await flush();
    expect(onPasteImage).toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("falls back to text paste when clipboard.read() is rejected", async () => {
    const read = vi.fn().mockRejectedValue(new Error("denied"));
    (navigator.clipboard as unknown as { read: typeof read }).read = read;
    const onPasteImage = vi.fn();
    const { term } = makeTerm();
    attachTerminalClipboard(term, { onPasteImage });
    term.fireKey(macPasteKey);
    await flush();
    expect(onPasteImage).not.toHaveBeenCalled();
    expect(term.paste).toHaveBeenCalledWith("pasted");
  });

  it("falls back to text paste when clipboard.read() is unavailable", async () => {
    const onPasteImage = vi.fn();
    const { term } = makeTerm();
    attachTerminalClipboard(term, { onPasteImage });
    term.fireKey(macPasteKey);
    await flush();
    expect(onPasteImage).not.toHaveBeenCalled();
    expect(term.paste).toHaveBeenCalledWith("pasted");
  });

  it("pastes on Ctrl+Shift+V on non-mac", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      platform: "Linux x86_64",
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue("linux-paste"),
      },
    });
    const { term } = makeTerm();
    attachTerminalClipboard(term);
    const result = term.fireKey({
      type: "keydown",
      key: "v",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    });
    expect(result).toBe(false);
  });
});

describe("pastedImageFilename", () => {
  const when = new Date(2026, 6, 14, 9, 5, 3);

  it("stamps the date and maps the mime type to an extension", () => {
    expect(pastedImageFilename("image/png", when)).toBe("pasted-image-20260714-090503.png");
    expect(pastedImageFilename("image/jpeg", when)).toBe("pasted-image-20260714-090503.jpg");
  });

  it("defaults unknown mime types to png", () => {
    expect(pastedImageFilename("image/x-unknown", when)).toBe("pasted-image-20260714-090503.png");
  });
});
