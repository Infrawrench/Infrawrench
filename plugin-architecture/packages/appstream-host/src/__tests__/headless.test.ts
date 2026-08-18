import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";

import {
  FrameDecoder,
  FrameKind,
  decodeInputBatch,
  encodeControl,
  encodeFrame,
  type AppSessionTransport,
  type InputEvent,
  type ServerMessage,
} from "@infrawrench/appstream-core";

import { HeadlessAppClient, headlessClientCaps } from "../headless.js";
import { encodePng } from "../png.js";

const welcome: ServerMessage = {
  type: "welcome",
  protocol: 1,
  sessionId: "s1",
  version: "0.1.0",
  caps: {
    vp9: false,
    webp: false,
    jpeg: true,
    xwayland: false,
    audio: false,
    runtimeDir: true,
    a11y: true,
  },
  pixelFormat: "bgra8888",
  keymap: "",
};

/** A transport that records what the client sent and lets a test talk back. */
class FakeTransport implements AppSessionTransport {
  sent: Uint8Array[] = [];
  #onMessage?: (bytes: Uint8Array) => void;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.#onMessage = handler;
  }
  onClose(): void {}
  close(): void {}

  reply(message: ServerMessage): void {
    this.#onMessage?.(encodeFrame(FrameKind.ControlServer, 0, encodeControl(message)));
  }
  deliverPixels(windowId: number, payload: Uint8Array): void {
    this.#onMessage?.(encodeFrame(FrameKind.Pixels, windowId, payload));
  }

  controls(): Array<Record<string, unknown>> {
    const decoder = new FrameDecoder();
    for (const bytes of this.sent) decoder.push(bytes);
    return [...decoder.drain()]
      .filter((frame) => frame.kind === FrameKind.ControlClient)
      .map(
        (frame) => JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>,
      );
  }

  inputBatches(): InputEvent[][] {
    const decoder = new FrameDecoder();
    for (const bytes of this.sent) decoder.push(bytes);
    return [...decoder.drain()]
      .filter((frame) => frame.kind === FrameKind.Input)
      .map((frame) => decodeInputBatch(frame.payload));
  }
}

async function connected(): Promise<{ transport: FakeTransport; client: HeadlessAppClient }> {
  const transport = new FakeTransport();
  const pending = HeadlessAppClient.connect(transport, { width: 4, height: 3 });
  transport.reply(welcome);
  const client = await pending;
  return { transport, client };
}

function openWindow(transport: FakeTransport, windowId: number): void {
  transport.reply({
    type: "windowOpen",
    windowId,
    title: "app",
    width: 4,
    height: 3,
  });
}

/** A whole-canvas RawRects keyframe holding BGRA pixels. */
function rawKeyframe(width: number, height: number, bgra: Uint8Array, seq = 1): Uint8Array {
  const header = new Uint8Array(12 + 13);
  const view = new DataView(header.buffer);
  header[0] = 0; // RawRects
  header[1] = 1; // keyframe
  view.setUint16(2, 1, true); // one rect
  view.setUint32(4, seq, true);
  view.setUint16(8, width, true);
  view.setUint16(10, height, true);
  view.setUint16(12, 0, true); // x
  view.setUint16(14, 0, true); // y
  view.setUint16(16, width, true);
  view.setUint16(18, height, true);
  header[20] = 0; // RectOp.Pixels
  view.setUint32(21, 0, true); // solid, unused
  const out = new Uint8Array(header.length + bgra.length);
  out.set(header);
  out.set(bgra, header.length);
  return out;
}

/** Decode our own PNG output back to raw RGBA scanlines. */
function pngPixels(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  // IHDR is always 13 bytes, so IDAT starts at a fixed offset.
  const idatLength = png.readUInt32BE(33);
  expect(png.subarray(37, 41).toString("ascii")).toBe("IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0); // filter type
    rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, rgba };
}

describe("headless caps", () => {
  it("rule out every browser-decoded tier", () => {
    expect(headlessClientCaps()).toMatchObject({
      vp9: false,
      webp: false,
      jpeg: false,
      zstd: true,
      delta: true,
      audio: false,
    });
  });
});

describe("screenshots", () => {
  it("reconstructs BGRA wire pixels into an RGBA png", async () => {
    const { transport, client } = await connected();
    openWindow(transport, 1);

    // 4x3 of solid blue-ish BGRA: b=200, g=100, r=50, a=255.
    const bgra = new Uint8Array(4 * 3 * 4);
    for (let i = 0; i < bgra.length; i += 4) {
      bgra[i] = 200;
      bgra[i + 1] = 100;
      bgra[i + 2] = 50;
      bgra[i + 3] = 255;
    }
    const pending = client.screenshot(1, { quietMs: 0 });
    transport.deliverPixels(1, rawKeyframe(4, 3, bgra));
    const shot = await pending;

    expect(shot.width).toBe(4);
    expect(shot.height).toBe(3);
    const decoded = pngPixels(shot.png);
    expect(decoded.width).toBe(4);
    expect([...decoded.rgba.subarray(0, 4)]).toEqual([50, 100, 200, 255]);
    // Screenshotting attached the window at the client's size, scale 1.
    expect(transport.controls()).toContainEqual(
      expect.objectContaining({ type: "attach", windowId: 1, width: 4, height: 3, scale: 1 }),
    );
  });

  it("refuses a window that never painted rather than returning black", async () => {
    const { transport, client } = await connected();
    openWindow(transport, 1);
    await expect(client.screenshot(1, { quietMs: 0, timeoutMs: 100 })).rejects.toThrow(
      /never painted/,
    );
  });
});

describe("input synthesis", () => {
  it("aims a click in fixed-point buffer pixels, motion first", async () => {
    const { transport, client } = await connected();
    openWindow(transport, 1);
    client.click(1, 10, 20);
    const [events] = transport.inputBatches();
    expect(events).toHaveLength(3);
    expect(events![0]).toMatchObject({ kind: "pointerMotion", x: 10 * 256, y: 20 * 256 });
    expect(events![1]).toMatchObject({ kind: "pointerButton", button: 0x110, state: 1 });
    expect(events![2]).toMatchObject({ kind: "pointerButton", button: 0x110, state: 0 });
  });

  it("double-clicks as two press-release pairs", async () => {
    const { transport, client } = await connected();
    openWindow(transport, 1);
    client.click(1, 5, 5, { button: "right", clicks: 2 });
    const [events] = transport.inputBatches();
    expect(events!.filter((e) => e.kind === "pointerButton")).toHaveLength(4);
    expect(events![1]).toMatchObject({ kind: "pointerButton", button: 0x111 });
  });

  it("scrolls ten logical units per notch, after a motion", async () => {
    const { transport, client } = await connected();
    openWindow(transport, 1);
    client.scroll(1, 8, 8, 3);
    const [events] = transport.inputBatches();
    expect(events![0]!.kind).toBe("pointerMotion");
    expect(events![1]).toMatchObject({ kind: "pointerAxis", dx: 0, dy: 30 * 256 });
  });

  it("types shifted characters and keysym-only characters alike", async () => {
    const { transport, client } = await connected();
    openWindow(transport, 1);
    client.typeText(1, "Hé\n");
    const [events] = transport.inputBatches();
    const kinds = events!.map((e) => e.kind);
    // "H" needs a synthesised shift around KeyH (evdev 35).
    expect(events!.some((e) => e.kind === "key" && e.keycode === 42)).toBe(true);
    expect(events!.some((e) => e.kind === "key" && e.keycode === 35)).toBe(true);
    // "é" travels as a keysym (latin-1 identity).
    expect(events!.some((e) => e.kind === "keysym" && e.keysym === 0xe9)).toBe(true);
    // "\n" is Enter by position (evdev 28).
    expect(events!.some((e) => e.kind === "key" && e.keycode === 28)).toBe(true);
    expect(kinds.every((kind) => kind === "key" || kind === "keysym")).toBe(true);
  });

  it("wraps a chord's key in its modifiers, released in reverse", async () => {
    const { transport, client } = await connected();
    openWindow(transport, 1);
    client.pressKeys(1, "ctrl+shift+T");
    const [events] = transport.inputBatches();
    const keys = events!.filter((e): e is Extract<InputEvent, { kind: "key" }> => e.kind === "key");
    // ctrl(29) down, shift(42) down … t(20) … shift up, ctrl up.
    expect(keys[0]).toMatchObject({ keycode: 29, state: 1 });
    expect(keys[1]).toMatchObject({ keycode: 42, state: 1 });
    expect(keys.some((e) => e.keycode === 20)).toBe(true);
    expect(keys.at(-2)).toMatchObject({ keycode: 42, state: 0 });
    expect(keys.at(-1)).toMatchObject({ keycode: 29, state: 0 });
  });

  it("presses named keys by position", async () => {
    const { transport, client } = await connected();
    openWindow(transport, 1);
    client.pressKeys(1, "Enter");
    const [events] = transport.inputBatches();
    expect(events![0]).toMatchObject({ kind: "key", keycode: 28, state: 1 });
    expect(events![1]).toMatchObject({ kind: "key", keycode: 28, state: 0 });
  });
});

describe("accessibility passthrough", () => {
  it("resolves the session's a11y answer", async () => {
    const { transport, client } = await connected();
    openWindow(transport, 1);
    const pending = client.a11yTree(1);
    const request = transport.controls().find((c) => c["type"] === "a11yTree");
    expect(request).toMatchObject({ windowId: 1, requestId: 1 });
    transport.reply({
      type: "a11yTree",
      windowId: 1,
      requestId: 1,
      ok: true,
      tree: { role: "frame" },
    });
    await expect(pending).resolves.toEqual({ tree: { role: "frame" } });
  });
});

describe("png encoder", () => {
  it("round-trips pixels exactly", () => {
    const rgba = new Uint8Array(2 * 2 * 4);
    rgba.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const decoded = pngPixels(encodePng(rgba, 2, 2));
    expect([...decoded.rgba]).toEqual([...rgba]);
  });

  it("refuses a buffer that does not match its dimensions", () => {
    expect(() => encodePng(new Uint8Array(3), 2, 2)).toThrow(/expected 16/);
  });
});
