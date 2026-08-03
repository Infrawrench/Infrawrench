// WebSocket shim that lets the ironrdp-wasm client tunnel RDP over Electron IPC
// instead of a real network socket.
//
// The WASM client's only transport hook is `SessionBuilder.proxyAddress(url)` —
// internally it does `new WebSocket(url)` and reads/writes RDP bytes on it. We
// can't hand it an IPC channel directly, so we replace the renderer's global
// `WebSocket` with a wrapper that intercepts our sentinel URL and returns an
// IPC-backed fake; every other URL (notably the cloud SSH terminal's real
// WebSocket) is delegated untouched to the platform implementation.
//
// The fake speaks exactly the subset of the WebSocket API that wasm-bindgen's
// glue uses: `binaryType`, `send()`, `close()`, `readyState`, the `on*`
// handlers, and `addEventListener`/`removeEventListener`, dispatching real
// `MessageEvent`/`CloseEvent` objects. Its prototype chain includes the real
// `WebSocket.prototype` so `instanceof WebSocket` holds, but every method the
// client touches is our own — we never invoke a real socket's branded methods.
import { invoke } from "./invoke";

// A host that can never resolve on the network, so a delegation bug fails
// closed rather than dialling out. The path carries the IPC session id.
const SENTINEL_HOST = "rdp-ipc.invalid";

/** Build the proxyAddress the WASM client should be given for a session. */
export function rdpProxyAddress(sessionId: string): string {
  return `ws://${SENTINEL_HOST}/${sessionId}`;
}

type Listener = (event: Event) => void;

class IpcRdpSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly bufferedAmount = 0;
  readonly extensions = "";
  readonly protocol = "";

  #sessionId: string;
  #dataChannel: string;
  #closedChannel: string;
  #listeners = new Map<string, Set<Listener>>();
  #onHandlers: Record<string, Listener | null> = {
    open: null,
    message: null,
    close: null,
    error: null,
  };

  constructor(sessionId: string, url: string) {
    this.url = url;
    this.#sessionId = sessionId;
    this.#dataChannel = `rdp_ws_data_${sessionId}`;
    this.#closedChannel = `rdp_ws_closed_${sessionId}`;

    window.electronAPI.on(this.#dataChannel, (payload: unknown) => {
      // Electron delivers the main-process Buffer as a Uint8Array. Hand the
      // client an ArrayBuffer copy (binaryType is "arraybuffer" once the WASM
      // sets it) sliced to the exact view bounds.
      const view = payload as Uint8Array;
      const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      this.#emit(new MessageEvent("message", { data: buffer }));
    });
    window.electronAPI.on(this.#closedChannel, () => {
      this.#teardownListeners();
      this.readyState = this.CLOSED;
      this.#emit(new CloseEvent("close", { code: 1006, wasClean: false }));
    });

    // The IPC session already exists (opened before this URL was built), so the
    // socket is effectively connected. Fire `open` on a microtask so the client
    // can attach its handlers first, matching real WebSocket semantics.
    queueMicrotask(() => {
      if (this.readyState !== this.CONNECTING) return;
      this.readyState = this.OPEN;
      this.#emit(new Event("open"));
    });
  }

  send(data: ArrayBuffer | ArrayBufferView | Blob | string): void {
    if (this.readyState !== this.OPEN) return;
    let bytes: Uint8Array;
    if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data.slice(0));
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } else {
      // Blob — the RDP client never sends these, but handle it rather than drop.
      void data.arrayBuffer().then((buf) => {
        void invoke("rdp_ws_send", { sessionId: this.#sessionId, data: new Uint8Array(buf) });
      });
      return;
    }
    void invoke("rdp_ws_send", { sessionId: this.#sessionId, data: bytes });
  }

  close(): void {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSING;
    void invoke("rdp_ws_close", { sessionId: this.#sessionId }).finally(() => {
      this.#teardownListeners();
      this.readyState = this.CLOSED;
      this.#emit(new CloseEvent("close", { code: 1000, wasClean: true }));
    });
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    this.#emit(event);
    return true;
  }

  get onopen(): Listener | null {
    return this.#onHandlers["open"] ?? null;
  }
  set onopen(fn: Listener | null) {
    this.#onHandlers["open"] = fn;
  }
  get onmessage(): Listener | null {
    return this.#onHandlers["message"] ?? null;
  }
  set onmessage(fn: Listener | null) {
    this.#onHandlers["message"] = fn;
  }
  get onclose(): Listener | null {
    return this.#onHandlers["close"] ?? null;
  }
  set onclose(fn: Listener | null) {
    this.#onHandlers["close"] = fn;
  }
  get onerror(): Listener | null {
    return this.#onHandlers["error"] ?? null;
  }
  set onerror(fn: Listener | null) {
    this.#onHandlers["error"] = fn;
  }

  #emit(event: Event): void {
    this.#onHandlers[event.type]?.call(this, event);
    const set = this.#listeners.get(event.type);
    if (set) for (const listener of [...set]) listener.call(this, event);
  }

  #teardownListeners(): void {
    window.electronAPI.offAll(this.#dataChannel);
    window.electronAPI.offAll(this.#closedChannel);
  }
}

// instanceof WebSocket must still hold for any client brand-check, but our own
// methods shadow the real (branded) ones so a real socket is never touched.
Object.setPrototypeOf(IpcRdpSocket.prototype, WebSocket.prototype);

let installed = false;

/**
 * Install the shim once. Idempotent and safe to call before every session —
 * all non-sentinel URLs fall through to the platform WebSocket unchanged.
 */
export function installRdpWebSocketShim(): void {
  if (installed) return;
  installed = true;
  const RealWebSocket = window.WebSocket;

  const Patched = function WebSocket(
    this: unknown,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const href = typeof url === "string" ? url : url.href;
    try {
      const parsed = new URL(href);
      if (parsed.hostname === SENTINEL_HOST) {
        const sessionId = parsed.pathname.replace(/^\//, "");
        return new IpcRdpSocket(sessionId, href) as unknown as WebSocket;
      }
    } catch {
      /* fall through to the real implementation */
    }
    return new RealWebSocket(url, protocols);
  } as unknown as typeof WebSocket;

  Patched.prototype = RealWebSocket.prototype;
  // The readyState constants are `readonly` on `typeof WebSocket`; copy them via
  // defineProperty so callers reading `WebSocket.OPEN` still see them.
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    Object.defineProperty(Patched, key, { value: RealWebSocket[key], enumerable: true });
  }
  window.WebSocket = Patched;
}
