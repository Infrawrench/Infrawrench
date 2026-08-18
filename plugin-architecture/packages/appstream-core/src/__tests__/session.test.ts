import { describe, expect, it } from "vitest";

import { AUDIO_HEADER_LEN, AudioCodec, type AudioChunk } from "../audio.js";
import { FrameDecoder, FrameKind, encodeClipboardBlob, encodeFrame } from "../frame.js";
import { ButtonState } from "../input.js";
import { encodeControl, type ClientCaps, type ServerMessage } from "../messages.js";
import { AppSession, type AppSessionEvents, type AppSessionTransport } from "../session.js";

const caps: ClientCaps = {
  vp9: false,
  webp: true,
  zstd: true,
  jpeg: true,
  delta: true,
  audio: true,
  maxFrameBytes: 1 << 20,
};

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

  it("fans a launch result out to subscribers, not just the owner", () => {
    // The launcher component subscribes and unsubscribes with its own
    // lifetime, which the single events object cannot express.
    const seen: Array<{ ok: boolean; message?: string; appId?: string }> = [];
    const { transport, app } = session();
    transport.reply(welcome);
    app.addLaunchResultListener((result) => seen.push(result));
    transport.reply({ type: "launchResult", appId: "gimp.desktop", ok: false, message: "no gtk" });
    expect(seen).toEqual([{ ok: false, message: "no gtk", appId: "gimp.desktop" }]);
  });

  it("treats a failed launch as an answer to that launch, not a dead session", () => {
    // The host reports a child that died as an `error` frame. Reporting it as
    // a session error would paint the launcher red for good over one bad
    // entry, when every other application still starts.
    const fatal: string[] = [];
    const launches: Array<{ ok: boolean; message?: string }> = [];
    const { transport, app } = session({ onError: (message) => fatal.push(message) });
    transport.reply(welcome);
    app.addLaunchResultListener((result) => launches.push(result));
    transport.reply({
      type: "error",
      code: "launchFailed",
      message: "libgtk-3.so.0: cannot open shared object file",
    });
    expect(fatal).toEqual([]);
    expect(launches).toEqual([
      { ok: false, message: "libgtk-3.so.0: cannot open shared object file" },
    ]);
  });

  it("still reports an error that ends the session", () => {
    const fatal: Array<[string, string | undefined]> = [];
    const { transport } = session({ onError: (message, code) => fatal.push([message, code]) });
    transport.reply(welcome);
    transport.reply({ type: "error", code: "noRuntimeDir", message: "no XDG_RUNTIME_DIR" });
    expect(fatal).toEqual([["no XDG_RUNTIME_DIR", "noRuntimeDir"]]);
  });

  it("keeps delivering a launch result when one subscriber throws", () => {
    const seen: boolean[] = [];
    const { transport, app } = session();
    transport.reply(welcome);
    app.addLaunchResultListener(() => {
      throw new Error("a launcher unmounted mid-update");
    });
    app.addLaunchResultListener((result) => seen.push(result.ok));
    transport.reply({ type: "launchResult", ok: true });
    expect(seen).toEqual([true]);
  });

  it("stops delivering launch results after a listener is removed", () => {
    const seen: boolean[] = [];
    const { transport, app } = session();
    transport.reply(welcome);
    const listener = (result: { ok: boolean }) => seen.push(result.ok);
    app.addLaunchResultListener(listener);
    app.removeLaunchResultListener(listener);
    transport.reply({ type: "launchResult", ok: false, message: "nope" });
    expect(seen).toEqual([]);
  });

  it("fetches a clipboard the host offers, without being asked", () => {
    // Fetching on the offer rather than on the paste is what makes a paste
    // instant; the offer itself carries nothing, so nothing has crossed the
    // wire until this.
    const { transport, app } = session();
    transport.reply(welcome);
    app.attach(1, 100, 100, 1);
    transport.sent = [];
    transport.reply({
      type: "clipboardOffer",
      mimeTypes: ["text/plain;charset=utf-8", "TARGETS"],
    });
    expect(transport.controls()).toContainEqual({
      type: "clipboardRequest",
      mimeType: "text/plain;charset=utf-8",
    });
  });

  it("ignores an offer of something it could not paste anyway", () => {
    // An image on a remote clipboard is megabytes over an SSH connection
    // nobody agreed to spend.
    const { transport } = session();
    transport.reply(welcome);
    transport.sent = [];
    transport.reply({ type: "clipboardOffer", mimeTypes: ["image/png"] });
    expect(transport.controls()).toEqual([]);
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

/** A minimal raw-PCM audio chunk frame. */
function audioFrame(seq: number, samples: number[]): Uint8Array {
  const payload = new Uint8Array(AUDIO_HEADER_LEN + samples.length * 2);
  const view = new DataView(payload.buffer);
  payload[0] = AudioCodec.PcmS16;
  payload[1] = 2; // channels
  view.setUint16(2, 0, true); // flags
  view.setUint32(4, seq, true);
  view.setUint32(8, 48_000, true);
  samples.forEach((sample, i) => view.setInt16(AUDIO_HEADER_LEN + i * 2, sample, true));
  return encodeFrame(FrameKind.Audio, 0, payload);
}

describe("AppSession audio", () => {
  it("delivers chunks to audio listeners and never acks them", () => {
    const { transport, app } = session();
    transport.reply(welcome);
    const seen: AudioChunk[] = [];
    app.addAudioListener((chunk) => seen.push(chunk));

    transport.deliver(audioFrame(7, [100, -100]));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ codec: AudioCodec.PcmS16, seq: 7, sampleRate: 48_000 });
    // Acks are the pixel flow-control credit; an audio chunk must not mint one.
    expect(transport.controls().filter((message) => message.type === "ack")).toHaveLength(0);
  });

  it("keeps delivering when one listener throws", () => {
    const { transport, app } = session();
    transport.reply(welcome);
    const seen: number[] = [];
    app.addAudioListener(() => {
      throw new Error("player exploded");
    });
    app.addAudioListener((chunk) => seen.push(chunk.seq));

    transport.deliver(audioFrame(1, [0]));
    transport.deliver(audioFrame(2, [0]));

    expect(seen).toEqual([1, 2]);
  });

  it("queues setAudio until the handshake like any control message", () => {
    const { transport, app } = session();
    app.setAudioEnabled(false);
    expect(transport.controls()).toHaveLength(1); // just the hello

    transport.reply(welcome);
    expect(transport.controls()).toContainEqual({ type: "setAudio", enabled: false });
  });
});

describe("accessibility", () => {
  const a11yWelcome: ServerMessage = {
    ...welcome,
    caps: { ...welcome.caps, a11y: true },
  };

  it("resolves the request whose id the host answered", async () => {
    const { transport, app } = session();
    transport.reply(a11yWelcome);
    const promise = app.requestA11yTree(3);
    expect(transport.controls()[1]).toMatchObject({
      type: "a11yTree",
      windowId: 3,
      requestId: 1,
    });

    transport.reply({
      type: "a11yTree",
      windowId: 3,
      requestId: 1,
      ok: true,
      tree: { role: "frame", name: "Calc", children: [{ role: "push button", name: "=" }] },
    });
    await expect(promise).resolves.toEqual({
      tree: { role: "frame", name: "Calc", children: [{ role: "push button", name: "=" }] },
    });
  });

  it("carries the host's caveat beside a truncated tree", async () => {
    const { transport, app } = session();
    transport.reply(a11yWelcome);
    const promise = app.requestA11yTree(1);
    transport.reply({
      type: "a11yTree",
      windowId: 1,
      requestId: 1,
      ok: true,
      message: "tree truncated at 1500 nodes",
      tree: { role: "frame" },
    });
    await expect(promise).resolves.toEqual({
      tree: { role: "frame" },
      caveat: "tree truncated at 1500 nodes",
    });
  });

  it("rejects with the host's reason when there is no tree", async () => {
    const { transport, app } = session();
    transport.reply(a11yWelcome);
    const promise = app.requestA11yTree(1);
    transport.reply({
      type: "a11yTree",
      windowId: 1,
      requestId: 1,
      ok: false,
      message: "no application has registered an accessibility tree yet",
    });
    await expect(promise).rejects.toThrow(/no application has registered/);
  });

  it("refuses locally when the host never declared the capability", async () => {
    // An old host treats the unknown message as a bad frame, so it must never
    // be sent at all.
    const { transport, app } = session();
    transport.reply(welcome);
    await expect(app.requestA11yTree(1)).rejects.toThrow(/does not expose/);
    expect(transport.controls()).toHaveLength(1);
  });

  it("fails outstanding requests when the transport drops", async () => {
    const { transport, app } = session();
    transport.reply(a11yWelcome);
    const promise = app.requestA11yTree(1);
    transport.drop();
    await expect(promise).rejects.toThrow(/closed/);
  });
});
