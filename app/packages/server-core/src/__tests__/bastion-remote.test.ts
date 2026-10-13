import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch as undiciFetch } from "undici";
import { WebSocketServer, type WebSocket } from "ws";
import { destroyAllRemoteConnections, remoteDispatcherFor } from "../bastion/remote";
import { REALTIME_SECRET_HEADER } from "../realtime/protocol";

/**
 * A stand-in for the bastion relay: answers `relay-status`, opens streams on
 * request, and answers every stream with one canned HTTP response, so an
 * undici request through the remote dispatcher makes the whole round trip.
 */
function fakeRelay(options: { agentConnected: boolean }) {
  const wss = new WebSocketServer({ port: 0 });
  const seen: { secret?: string | undefined; path?: string | undefined; opens: string[] } = {
    opens: [],
  };
  wss.on("connection", (ws: WebSocket, request) => {
    seen.secret = request.headers[REALTIME_SECRET_HEADER] as string | undefined;
    seen.path = request.url;
    ws.send(JSON.stringify({ op: "relay-status", agentConnected: options.agentConnected }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { op: string; streamId: number; host?: string };
      if (msg.op === "open") {
        seen.opens.push(`${msg.host}`);
        ws.send(JSON.stringify({ op: "opened", streamId: msg.streamId }));
      }
      if (msg.op === "data") {
        const body = "relayed";
        const response = `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`;
        ws.send(
          JSON.stringify({
            op: "data",
            streamId: msg.streamId,
            data: Buffer.from(response).toString("base64"),
          }),
        );
        ws.send(JSON.stringify({ op: "close", streamId: msg.streamId }));
      }
    });
  });
  return { wss, seen, port: () => (wss.address() as AddressInfo).port };
}

describe("remoteDispatcherFor", () => {
  let relay: ReturnType<typeof fakeRelay> | null = null;

  beforeEach(() => {
    vi.stubEnv("INTERNAL_RELAY_SECRET", "test-secret");
  });

  afterEach(async () => {
    await destroyAllRemoteConnections();
    relay?.wss.close();
    relay = null;
    vi.unstubAllEnvs();
  });

  it("carries an HTTP request through the relay, authenticated with the relay secret", async () => {
    relay = fakeRelay({ agentConnected: true });
    vi.stubEnv("APP_URL", `http://127.0.0.1:${relay.port()}`);

    const dispatcher = await remoteDispatcherFor("bastion-1", async () => ["api.example.com"]);
    expect(dispatcher).not.toBeNull();
    const response = await undiciFetch("http://api.example.com/v1/things", {
      dispatcher: dispatcher!,
    });
    expect(await response.text()).toBe("relayed");
    expect(relay.seen.secret).toBe("test-secret");
    expect(relay.seen.path).toBe("/api/realtime/bastions/bastion-1");
    expect(relay.seen.opens).toEqual(["api.example.com"]);
  });

  it("refuses a destination outside the allowlist before anything reaches the relay", async () => {
    relay = fakeRelay({ agentConnected: true });
    vi.stubEnv("APP_URL", `http://127.0.0.1:${relay.port()}`);

    const dispatcher = await remoteDispatcherFor("bastion-2", async () => ["api.example.com"]);
    await expect(
      undiciFetch("http://169.254.169.254/", { dispatcher: dispatcher! }),
    ).rejects.toThrow();
    expect(relay.seen.opens).toEqual([]);
  });

  it("returns null when the relay has no agent for the bastion", async () => {
    relay = fakeRelay({ agentConnected: false });
    vi.stubEnv("APP_URL", `http://127.0.0.1:${relay.port()}`);
    expect(await remoteDispatcherFor("bastion-3", async () => [])).toBeNull();
  });

  it("is off without the relay settings", async () => {
    vi.stubEnv("APP_URL", "");
    expect(await remoteDispatcherFor("bastion-4", async () => [])).toBeNull();
  });
});
