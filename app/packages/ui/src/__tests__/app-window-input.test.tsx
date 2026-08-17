import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AppSession, InputEvent, PixelPayload } from "@infrawrench/appstream-core";
import { AppWindowViewer } from "../apps/AppWindowViewer.js";

// jsdom has no canvas, so it has no `ImageData` either. The viewer builds one
// to wrap its pixel buffer; nothing in these tests looks at what it draws, only
// at what it sends back up the wire.
class StubImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}
globalThis.ImageData ??= StubImageData as unknown as typeof ImageData;
// And no 2D context. Returning null is what the viewer already handles — it
// paints nothing and carries on — and saves jsdom logging a page of
// "not implemented" for every frame.
HTMLCanvasElement.prototype.getContext = () => null;

/**
 * Just enough of a session for the viewer to mount and report what it sent.
 *
 * The viewer only reaches for a handful of methods; standing them up by hand
 * keeps this a test of the input translation rather than of the protocol.
 */
function fakeSession() {
  const sent: InputEvent[] = [];
  const offered: string[] = [];
  const frameListeners: Array<(id: number, payload: PixelPayload) => unknown> = [];
  const session = {
    sendInput: (_windowId: number, events: InputEvent[]) => sent.push(...events),
    offerClipboard: (blob: { data: Uint8Array }) =>
      offered.push(new TextDecoder().decode(blob.data)),
    attach: vi.fn(),
    detach: vi.fn(),
    resize: vi.fn(),
    addFrameListener: (listener: (id: number, payload: PixelPayload) => unknown) =>
      frameListeners.push(listener),
    removeFrameListener: vi.fn(),
    addCursorListener: vi.fn(),
    removeCursorListener: vi.fn(),
  } as unknown as AppSession;
  return { session, sent, offered, frameListeners };
}

function mount() {
  const { session, sent, offered, frameListeners } = fakeSession();
  render(<AppWindowViewer session={session} windowId={1} />);
  const canvas = screen.getByRole("img");

  // Pointer input is measured against the frame buffer, so nothing is sent
  // until one frame has arrived — which is true of the real thing too: there
  // is nothing to point at before the window has drawn.
  const payload = {
    codec: 0,
    keyframe: true,
    seq: 1,
    width: 100,
    height: 100,
    rects: [{ x: 0, y: 0, w: 100, h: 100, op: 1, solid: 0 }],
    blob: new Uint8Array(),
  } as unknown as PixelPayload;
  for (const listener of frameListeners) listener(1, payload);
  sent.length = 0;
  return { canvas, sent, offered };
}

const keys = (sent: InputEvent[]) => sent.filter((e) => e.kind === "key");

describe("AppWindowViewer keyboard", () => {
  it("sends a press and a release for a tap", () => {
    const { canvas, sent } = mount();
    fireEvent.keyDown(canvas, { code: "KeyA" });
    fireEvent.keyUp(canvas, { code: "KeyA" });
    expect(keys(sent)).toHaveLength(2);
  });

  it("ignores the browser's auto-repeat", () => {
    // Wayland hands clients a repeat rate and they repeat for themselves, so
    // forwarding the browser's repeats too types everything twice over.
    const { canvas, sent } = mount();
    fireEvent.keyDown(canvas, { code: "KeyA" });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(canvas, { code: "KeyA", repeat: true });
    fireEvent.keyUp(canvas, { code: "KeyA" });
    expect(keys(sent)).toHaveLength(2);
  });

  it("releases a key still held when the window loses focus", () => {
    // The keyup goes to whatever has focus now, so the application would be
    // left holding the key down — and repeating it forever.
    const { canvas, sent } = mount();
    fireEvent.keyDown(canvas, { code: "KeyA" });
    fireEvent.keyDown(canvas, { code: "ShiftLeft" });
    sent.length = 0;
    fireEvent.blur(window);
    const released = keys(sent);
    expect(released).toHaveLength(2);
    expect(released.every((e) => e.kind === "key" && e.state === 0)).toBe(true);
  });

  it("does not release the same key twice", () => {
    const { canvas, sent } = mount();
    fireEvent.keyDown(canvas, { code: "KeyA" });
    fireEvent.keyUp(canvas, { code: "KeyA" });
    sent.length = 0;
    fireEvent.blur(window);
    expect(keys(sent)).toHaveLength(0);
  });
});

describe("AppWindowViewer clipboard", () => {
  const paste = (canvas: Element, text: string) =>
    fireEvent.paste(canvas, { clipboardData: { getData: () => text } });

  it("offers the text to the host before asking the application to paste", () => {
    // The application asks the compositor for the selection the moment it sees
    // the key, so the order is the whole thing: text first, keystroke second.
    const { canvas, sent, offered } = mount();
    paste(canvas, "hello");
    expect(offered).toEqual(["hello"]);
    expect(sent.map((e) => (e.kind === "key" ? e.keycode : e.kind))).toEqual([29, 47, 47, 29]);
  });

  it("synthesises the shortcut rather than forwarding the one that was pressed", () => {
    // Cmd+V on a Mac reaches a Linux application as Meta+V, which does
    // nothing at all — so the paste has to be made rather than relayed.
    const { canvas, sent } = mount();
    fireEvent.keyDown(canvas, { code: "KeyV", key: "v", metaKey: true });
    expect(sent).toEqual([]);
    paste(canvas, "text");
    expect(sent.filter((e) => e.kind === "key")).toHaveLength(4);
  });

  it("does nothing for an empty clipboard", () => {
    const { canvas, sent, offered } = mount();
    paste(canvas, "");
    expect(offered).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("AppWindowViewer wheel", () => {
  it("carries the pointer position with a scroll", () => {
    // A compositor delivers an axis event to whatever the pointer is over, so
    // a wheel with no motion behind it has nowhere to go.
    const { canvas, sent } = mount();
    fireEvent.wheel(canvas, { deltaY: 100, clientX: 10, clientY: 20 });
    expect(sent.map((e) => e.kind)).toEqual(["pointerMotion", "pointerAxis"]);
  });

  it("scrolls down for a positive delta", () => {
    const { canvas, sent } = mount();
    fireEvent.wheel(canvas, { deltaY: 100 });
    const axis = sent.find((e) => e.kind === "pointerAxis");
    expect(axis).toBeDefined();
    if (axis?.kind !== "pointerAxis") throw new Error("no axis event");
    expect(axis.dy).toBeGreaterThan(0);
  });
});
