import { describe, expect, it } from "vitest";

import { FrameDecoder, FrameKind, encodeClipboardBlob, encodeFrame } from "../frame.js";
import { ButtonState } from "../input.js";
import { encodeControl, type ClientCaps, type ServerMessage } from "../messages.js";
import { AppSession, type AppSessionEvents, type AppSessionTransport } from "../session.js";

const caps: ClientCaps = { vp9: false, webp: true, zstd: true, maxFrameBytes: 1 << 20 };

const welcome: ServerMessage = {
  type: "welcome",
  protocol: 1,
  sessionId: "s1",
  version: "0.1.0",
  caps: { vp9: false, webp: false, xwayland: false, audio: false, runtimeDir: true },
  pixelFormat: "bgra8888",
  keymap: "",
};

/** A transport that records what the session sent and lets a test talk back. */
class FakeTransport implements AppSessionTransport {
  sent: Uint8Array[] = [];
  closed = false;
  #onMessage?: (bytes: Uint8Array) => void;
  #onClose?: () => void;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.#onMessage = handler;
  }
  onClose(handler: () => void): void {
    this.#onClose = handler;
  }
  close(): void {
    this.closed = true;
  }

  /** Deliver raw bytes as if they arrived on the wire. */
  deliver(bytes: Uint8Array): void {
    this.#onMessage?.(bytes);
  }
  reply(message: ServerMessage): void {
    this.deliver(encodeFrame(FrameKind.ControlServer, 0, encodeControl(message)));
  }
  drop(): void {
    this.#onClose?.();
  }

  /** Everything sent so far, decoded back into frames. */
  outbound(): Array<{ kind: number; windowId: number; body: unknown }> {
    const decoder = new FrameDecoder();
    for (const bytes of this.sent) decoder.push(bytes);
    return [...decoder.drain()].map((frame) => ({
      kind: frame.kind,
      windowId: frame.windowId,
      body:
        frame.kind === FrameKind.ControlClient
          ? JSON.parse(new TextDecoder().decode(frame.payload))
          : frame.payload,
    }));
  }

  controls(): Array<Record<string, unknown>> {
    return this.outbound()
      .filter((frame) => frame.kind === FrameKind.ControlClient)
      .map((frame) => frame.body as Record<string, unknown>);
  }
}

function session(events: AppSessionEvents = {}): { transport: FakeTransport; app: AppSession } {
  const transport = new FakeTransport();
  return { transport, app: new AppSession(transport, { caps, events }) };
}

/** A minimal well-formed pixel payload with no rectangles. */
function pixelPayload(seq: number, keyframe = true): Uint8Array {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  payload[0] = 0; // RawRects
  payload[1] = keyframe ? 1 : 0;
  view.setUint16(2, 0, true); // rect count
  view.setUint32(4, seq, true);
  view.setUint16(8, 64, true);
  view.setUint16(10, 48, true);
  return payload;
}

describe("AppSession", () => {
  it("greets the host before anything else", () => {
    const { transport } = session();
    expect(transport.controls()[0]).toMatchObject({ type: "hello", protocol: 1, caps });
  });

  it("holds requests until the host has greeted back", () => {
    // The host rejects anything before the handshake, so sending eagerly would
    // end the session rather than list the applications.
    const { transport, app } = session();
    app.listApps();
    expect(transport.controls()).toHaveLength(1);

    transport.reply(welcome);
    expect(transport.controls()).toHaveLength(2);
    expect(transport.controls()[1]).toMatchObject({ type: "listApps", refresh: false });
    expect(app.ready).toBe(true);
  });

  it("refuses a host speaking another protocol version", () => {
    const errors: string[] = [];
    const { transport, app } = session({ onError: (message) => errors.push(message) });
    transport.reply({ ...welcome, protocol: 99 });
    expect(errors[0]).toMatch(/protocol 99/);
    expect(transport.closed).toBe(true);
    expect(app.ready).toBe(false);
  });

  it("tracks windows through open, retitle and close", () => {
    const log: string[] = [];
    const { transport, app } = session({
      onWindowOpen: (window) => log.push(`open:${window.title}`),
      onWindowMeta: (window) => log.push(`meta:${window.title}`),
      onWindowClose: (id, reason) => log.push(`close:${id}:${reason}`),
    });
    transport.reply(welcome);
    transport.reply({
      type: "windowOpen",
      windowId: 3,
      title: "untitled",
      appId: "editor",
      icon: "data:image/png;base64,AAA",
      width: 800,
      height: 600,
    });
    expect(app.window(3)).toMatchObject({ title: "untitled", width: 800 });

    transport.reply({ type: "windowMeta", windowId: 3, title: "notes.txt" });
    // A meta update carries only what changed; the icon has to survive it, or
    // a retitle would blank the tab's icon.
    expect(app.window(3)).toMatchObject({
      title: "notes.txt",
      icon: "data:image/png;base64,AAA",
    });

    transport.reply({ type: "windowClose", windowId: 3, reason: "closed" });
    expect(app.window(3)).toBeUndefined();
    expect(app.windows).toHaveLength(0);
    expect(log).toEqual(["open:untitled", "meta:notes.txt", "close:3:closed"]);
  });

  it("ignores metadata for a window it never saw open", () => {
    const seen: number[] = [];
    const { transport } = session({ onWindowMeta: (window) => seen.push(window.windowId) });
    transport.reply(welcome);
    transport.reply({ type: "windowMeta", windowId: 404, title: "ghost" });
    expect(seen).toEqual([]);
  });

  it("acks a frame only after the consumer has painted it", () => {
    let ackedDuringPaint: boolean | undefined;
    const painted: string[] = [];
    const { transport } = session({
      onFrame: (windowId, payload) => {
        painted.push(`${windowId}:${payload.seq}`);
        // The ack is what frees an in-flight slot on the host. Sending it
        // before the paint would let frames queue ahead of a slow viewer.
        ackedDuringPaint = transport.controls().some((message) => message["type"] === "ack");
      },
    });
    transport.reply(welcome);
    transport.sent = [];

    transport.deliver(encodeFrame(FrameKind.Pixels, 5, pixelPayload(42)));

    expect(painted).toEqual(["5:42"]);
    expect(ackedDuringPaint).toBe(false);
    expect(transport.controls()[0]).toMatchObject({ type: "ack", windowId: 5, seq: 42 });
  });

  it("reassembles a frame split across transport chunks", () => {
    const painted: number[] = [];
    const { transport } = session({ onFrame: (_, payload) => painted.push(payload.seq) });
    transport.reply(welcome);

    const frame = encodeFrame(FrameKind.Pixels, 1, pixelPayload(7));
    transport.deliver(frame.subarray(0, 6));
    expect(painted).toEqual([]);
    transport.deliver(frame.subarray(6));
    expect(painted).toEqual([7]);
  });

  it("sends input as a packed binary frame addressed to the window", () => {
    const { transport, app } = session();
    transport.reply(welcome);
    transport.sent = [];
    app.sendInput(9, [{ kind: "key", timeMs: 4, keycode: 30, state: ButtonState.Pressed }]);

    const [frame] = transport.outbound();
    expect(frame?.kind).toBe(FrameKind.Input);
    expect(frame?.windowId).toBe(9);
    expect((frame?.body as Uint8Array).length).toBe(10);
  });

  it("drops input sent before the handshake rather than queueing it", () => {
    // Queued keystrokes would arrive seconds late and type into whatever has
    // focus by then.
    const { transport, app } = session();
    transport.sent = [];
    app.sendInput(9, [{ kind: "key", timeMs: 4, keycode: 30, state: ButtonState.Pressed }]);
    expect(transport.sent).toHaveLength(0);
  });

  it("passes a launch result through with its message", () => {
    const results: Array<[boolean, string | undefined]> = [];
    const { transport, app } = session({
      onLaunchResult: (ok, message) => results.push([ok, message]),
    });
    transport.reply(welcome);
    app.launch({ appId: "vim.desktop" });
    transport.reply({
      type: "launchResult",
      appId: "vim.desktop",
      ok: false,
      message: "this entry needs a terminal emulator",
    });
    expect(results).toEqual([[false, "this entry needs a terminal emulator"]]);
  });

  it("hands clipboard payloads over as binary, not text", () => {
    const received: Array<{ mimeType: string; length: number }> = [];
    const { transport } = session({
      onClipboard: (blob) => received.push({ mimeType: blob.mimeType, length: blob.data.length }),
    });
    transport.reply(welcome);
    const blob = encodeClipboardBlob({
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });
    transport.deliver(encodeFrame(FrameKind.ClipboardServer, 0, blob));
    expect(received).toEqual([{ mimeType: "image/png", length: 3 }]);
  });

  it("reports the transport going away", () => {
    let closed = false;
    const { transport } = session({ onClose: () => (closed = true) });
    transport.drop();
    expect(closed).toBe(true);
  });
});

describe("AppSession listeners", () => {
  const pixels = (seq: number) => {
    const payload = new Uint8Array(12);
    const view = new DataView(payload.buffer);
    view.setUint32(4, seq, true);
    view.setUint16(8, 8, true);
    view.setUint16(10, 8, true);
    return encodeFrame(FrameKind.Pixels, 1, payload);
  };

  it("fans a frame out to every subscriber and still acks", () => {
    const { transport } = session();
    transport.reply(welcome);
    transport.sent = [];

    const seen: string[] = [];
    const first = (id: number) => seen.push(`first:${id}`);
    const second = (id: number) => seen.push(`second:${id}`);
    const app = new AppSession(transport, { caps });
    app.addFrameListener(first);
    app.addFrameListener(second);
    transport.deliver(pixels(5));

    expect(seen).toEqual(["first:1", "second:1"]);
  });

  it("keeps painting and acking when one viewer throws", () => {
    // A session that stops acking stops receiving, so one broken viewer must
    // not take the window down with it.
    const transport = new FakeTransport();
    const app = new AppSession(transport, { caps });
    transport.reply(welcome);
    transport.sent = [];

    const painted: number[] = [];
    app.addFrameListener(() => {
      throw new Error("decode failed");
    });
    app.addFrameListener((id) => painted.push(id));
    transport.deliver(pixels(7));

    expect(painted).toEqual([1]);
    expect(transport.controls().some((message) => message["type"] === "ack")).toBe(true);
  });

  it("stops delivering after a listener is removed", () => {
    const transport = new FakeTransport();
    const app = new AppSession(transport, { caps });
    transport.reply(welcome);

    const seen: number[] = [];
    const listener = (id: number) => seen.push(id);
    app.addFrameListener(listener);
    transport.deliver(pixels(1));
    app.removeFrameListener(listener);
    transport.deliver(pixels(2));

    expect(seen).toEqual([1]);
  });
});

describe("AppSession window subscriptions", () => {
  it("reports the host's session id once it has greeted", () => {
    const { transport, app } = session();
    expect(app.sessionId).toBeUndefined();
    transport.reply(welcome);
    expect(app.sessionId).toBe("s1");
  });

  it("notifies on open and on every retitle", () => {
    const { transport, app } = session();
    transport.reply(welcome);
    const seen: string[] = [];
    app.addWindowListener((id, window) => seen.push(`${id}:${window.title}`));

    transport.reply({
      type: "windowOpen",
      windowId: 2,
      title: "untitled",
      width: 100,
      height: 100,
    });
    transport.reply({ type: "windowMeta", windowId: 2, title: "notes.txt" });

    expect(seen).toEqual(["2:untitled", "2:notes.txt"]);
  });

  it("notifies close with the reason, so a tab can say why", () => {
    const { transport, app } = session();
    transport.reply(welcome);
    const closed: string[] = [];
    app.addWindowCloseListener((id, reason) => closed.push(`${id}:${reason}`));

    transport.reply({ type: "windowOpen", windowId: 3, title: "x", width: 1, height: 1 });
    transport.reply({ type: "windowClose", windowId: 3, reason: "crashed" });

    expect(closed).toEqual(["3:crashed"]);
  });
});
