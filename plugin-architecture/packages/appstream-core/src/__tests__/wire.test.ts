import { describe, expect, it } from "vitest";

import {
  FrameDecoder,
  FrameKind,
  MAX_FRAME_LEN,
  ProtocolError,
  decodeClipboardBlob,
  encodeClipboardBlob,
  encodeFrame,
} from "../frame.js";
import {
  ButtonState,
  PointerButton,
  axisFromWheel,
  decodeInputBatch,
  encodeInputBatch,
  evdevFromCode,
  fixedFromPx,
  pointerButtonFromDom,
  pointerPosition,
  type InputEvent,
} from "../input.js";

describe("frame envelope", () => {
  it("round-trips a frame", () => {
    const decoder = new FrameDecoder();
    decoder.push(encodeFrame(FrameKind.Pixels, 7, new Uint8Array([1, 2, 3])));
    const frame = decoder.next();
    expect(frame).toEqual({
      kind: FrameKind.Pixels,
      windowId: 7,
      payload: new Uint8Array([1, 2, 3]),
    });
    expect(decoder.next()).toBeUndefined();
  });

  it("reassembles across arbitrary chunk boundaries", () => {
    const stream = new Uint8Array([
      ...encodeFrame(FrameKind.ControlServer, 0, new Uint8Array([9])),
      ...encodeFrame(FrameKind.Pixels, 3, new Uint8Array(40).fill(7)),
      ...encodeFrame(FrameKind.ClipboardServer, 0, new Uint8Array([1, 2])),
    ]);

    // One byte at a time is what a slow transport actually delivers.
    const decoder = new FrameDecoder();
    const seen = [];
    for (const byte of stream) {
      decoder.push(new Uint8Array([byte]));
      seen.push(...decoder.drain());
    }
    expect(seen.map((f) => f.kind)).toEqual([
      FrameKind.ControlServer,
      FrameKind.Pixels,
      FrameKind.ClipboardServer,
    ]);
    expect(seen[1]!.payload.length).toBe(40);
    expect(decoder.buffered).toBe(0);
  });

  it("keeps payloads alive after the buffer moves on", () => {
    // The viewer holds a pixel payload while it decodes; a view into a buffer
    // that is about to be reused would tear.
    const decoder = new FrameDecoder();
    decoder.push(encodeFrame(FrameKind.Pixels, 1, new Uint8Array([1, 2, 3, 4])));
    const frame = decoder.next()!;
    decoder.push(encodeFrame(FrameKind.Pixels, 2, new Uint8Array([9, 9, 9, 9])));
    decoder.next();
    expect([...frame.payload]).toEqual([1, 2, 3, 4]);
  });

  it("refuses a length it could not honestly allocate", () => {
    const decoder = new FrameDecoder();
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, MAX_FRAME_LEN + 1, true);
    decoder.push(bytes);
    expect(() => decoder.next()).toThrow(ProtocolError);
  });

  it("refuses a length shorter than its own header", () => {
    const decoder = new FrameDecoder();
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, 4, true);
    decoder.push(bytes);
    expect(() => decoder.next()).toThrow(/shorter than/);
  });

  it("refuses an unknown kind", () => {
    const decoder = new FrameDecoder();
    const bytes = new Uint8Array(9);
    new DataView(bytes.buffer).setUint32(0, 5, true);
    bytes[4] = 0x7f;
    decoder.push(bytes);
    expect(() => decoder.next()).toThrow(/unknown frame kind 0x7f/);
  });

  it("round-trips a clipboard blob with binary data", () => {
    const blob = { mimeType: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]) };
    expect(decodeClipboardBlob(encodeClipboardBlob(blob))).toEqual(blob);
  });

  it("refuses a truncated clipboard blob", () => {
    expect(() => decodeClipboardBlob(new Uint8Array([9, 0, 120]))).toThrow(ProtocolError);
  });
});

describe("input", () => {
  const sample: InputEvent[] = [
    { kind: "key", timeMs: 12, keycode: 30, state: ButtonState.Pressed },
    { kind: "keysym", timeMs: 13, keysym: 0x00e9, state: ButtonState.Released },
    { kind: "pointerMotion", timeMs: 50, x: fixedFromPx(320), y: fixedFromPx(-12) },
    { kind: "pointerButton", timeMs: 51, button: PointerButton.Right, state: ButtonState.Pressed },
    { kind: "pointerAxis", timeMs: 52, dx: 0, dy: fixedFromPx(10) },
    { kind: "pointerLeave", timeMs: 53 },
    { kind: "touchDown", timeMs: 54, id: 1, x: fixedFromPx(4), y: fixedFromPx(5) },
    { kind: "touchMotion", timeMs: 55, id: 1, x: fixedFromPx(6), y: fixedFromPx(7) },
    { kind: "touchUp", timeMs: 56, id: 1 },
  ];

  it("round-trips every event kind", () => {
    expect(decodeInputBatch(encodeInputBatch(sample))).toEqual(sample);
  });

  it("packs a motion event into thirteen bytes", () => {
    // The same number the Rust encoder produces — a drag at 120 Hz is a
    // hundred of these a second.
    expect(encodeInputBatch([{ kind: "pointerMotion", timeMs: 1, x: 2, y: 3 }]).length).toBe(13);
  });

  it("refuses a truncated batch rather than inventing an event", () => {
    const bytes = encodeInputBatch(sample);
    expect(() => decodeInputBatch(bytes.subarray(0, bytes.length - 1))).toThrow(/truncated/);
  });

  it("maps DOM buttons to evdev, not to DOM order", () => {
    expect(pointerButtonFromDom(0)).toBe(PointerButton.Left);
    expect(pointerButtonFromDom(1)).toBe(PointerButton.Middle);
    expect(pointerButtonFromDom(2)).toBe(PointerButton.Right);
    expect(pointerButtonFromDom(9)).toBeUndefined();
  });

  it("maps physical key positions to evdev codes", () => {
    expect(evdevFromCode("KeyA")).toBe(30);
    expect(evdevFromCode("Enter")).toBe(28);
    expect(evdevFromCode("ArrowUp")).toBe(103);
    expect(evdevFromCode("MetaLeft")).toBe(125);
    expect(evdevFromCode("F11")).toBe(87);
    expect(evdevFromCode("NoSuchKey")).toBeUndefined();
  });

  it("normalises the three wheel modes to notches", () => {
    // A pixel-mode notch is ~100px, a line-mode notch 3 lines, a page 1.
    expect(axisFromWheel({ deltaX: 0, deltaY: 100, deltaMode: 0 }).dy).toBe(fixedFromPx(10));
    expect(axisFromWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }).dy).toBe(fixedFromPx(10));
    expect(axisFromWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }).dy).toBe(fixedFromPx(10));
    expect(axisFromWheel({ deltaX: -50, deltaY: 0 }).dx).toBe(fixedFromPx(-5));
  });

  it("scales pointer positions by the device pixel ratio", () => {
    // The compositor addresses the buffer; a position in CSS pixels is off by
    // the ratio on every retina screen.
    expect(pointerPosition(100, 50, 2)).toEqual({ x: fixedFromPx(200), y: fixedFromPx(100) });
    expect(pointerPosition(10.5, 0, 1)).toEqual({ x: fixedFromPx(10.5), y: 0 });
  });
});
