import type { ClientFrame, CloudFetch, ServerFrame } from "@infrawrench/client-core";

/**
 * One authenticated connection to the cloud WebSocket gateway (`/api/ws`).
 *
 * Flow (see app/packages/web/server.ts): POST /api/org/:orgId/ws-token mints a
 * single-use ~30s token, then we dial `wss://<host>/api/ws?token=…` and speak
 * JSON frames (`@infrawrench/client-core` ws-protocol types).
 *
 * No auto-reconnect: a dead pty cannot resume, so a dropped socket is surfaced
 * through the close listeners and the caller decides what to do.
 */
export class WsSession {
  private readonly api: CloudFetch;
  private readonly orgId: string;
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private readonly frameListeners = new Set<(frame: ServerFrame) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(message: string) => void>();

  constructor({ api, orgId }: { api: CloudFetch; orgId: string }) {
    this.api = api;
    this.orgId = orgId;
  }

  /** Mint a ws token and open the socket; resolves once the socket is open. */
  async connect(): Promise<void> {
    const minted = await this.api.org<{ token: string }>(this.orgId, "/ws-token", {
      method: "POST",
    });
    if (!minted?.token) throw new Error("Failed to mint a WebSocket token");

    const url = `${this.api.baseUrl.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(minted.token)}`;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      // A hung handshake would otherwise wait forever — the token is only
      // valid ~30s anyway.
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // Never opened.
        }
        reject(new Error("WebSocket connection timed out"));
      }, 10_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        settled = true;
        resolve();
      };
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        let frame: ServerFrame;
        try {
          frame = JSON.parse(event.data) as ServerFrame;
        } catch {
          return;
        }
        for (const cb of this.frameListeners) cb(frame);
      };
      ws.onerror = () => {
        for (const cb of this.errorListeners) cb("WebSocket connection error");
        if (!settled) {
          clearTimeout(timeout);
          settled = true;
          reject(new Error("WebSocket connection failed"));
        }
      };
      ws.onclose = () => {
        if (!this.closedByUs) {
          for (const cb of this.closeListeners) cb();
        }
        if (!settled) {
          clearTimeout(timeout);
          settled = true;
          reject(new Error("WebSocket closed before it opened"));
        }
      };
    });
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  send(frame: ClientFrame): void {
    if (this.isOpen) this.ws?.send(JSON.stringify(frame));
  }

  /** Register a server-frame listener; returns an unsubscribe function. */
  onFrame(cb: (frame: ServerFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  /** Fires when the socket closes for any reason other than our own close(). */
  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  onError(cb: (message: string) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  close(): void {
    this.closedByUs = true;
    try {
      this.ws?.close();
    } catch {
      // Already closed/never opened.
    }
    this.ws = null;
  }
}
