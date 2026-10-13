import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * The owner's side of the console relay against a stand-in relay: a call is
 * answered from the local hub, and a bridged guest is attached to the hub
 * through a socket whose frames travel over the host link.
 */

const hub = {
  has: vi.fn(() => true),
  describe: vi.fn(() => ({ organizationId: "org-1", host: "10.0.0.5", alreadyShared: null })),
  attach: vi.fn(() => ({ ok: true }) as const),
  handleAttachedMessage: vi.fn(),
  mark: vi.fn(),
  refresh: vi.fn(async () => undefined),
  detach: vi.fn(),
  revokeLocal: vi.fn(),
  bindShare: vi.fn(async () => true),
};
vi.mock("../shared-console/hub", () => ({ sharedConsoleHub: hub }));

const share = { id: "share-1", liveConsoleId: "live-1" };
const participant = { id: "p-1", sharedConsoleId: "share-1", userId: "u-1" };
vi.mock("@infrawrench/server-core/shared-console/store", () => ({
  getSharedConsoleByLiveId: vi.fn(async () => share),
  getSharedConsole: vi.fn(async () => share),
  getParticipantById: vi.fn(async () => participant),
  listParticipants: vi.fn(async () => [participant]),
}));

const { startHostLink, stopHostLink } = await import("../shared-console/relay");

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
}

describe("console relay host link", () => {
  let wss: WebSocketServer;
  let host: Promise<{ ws: WebSocket; secret: string | undefined; path: string | undefined }>;

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    host = new Promise((resolve) =>
      wss.once("connection", (ws, request) =>
        resolve({ ws, secret: request.headers["x-iw-relay-secret"] as string, path: request.url }),
      ),
    );
    vi.stubEnv("APP_URL", `http://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    vi.stubEnv("INTERNAL_RELAY_SECRET", "relay-secret");
  });

  afterEach(() => {
    stopHostLink("live-1");
    wss.close();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("connects as the console's host with the relay secret", async () => {
    startHostLink("live-1");
    const { secret, path } = await host;
    expect(secret).toBe("relay-secret");
    expect(path).toBe("/api/realtime/consoles/live-1/host");
  });

  it("answers a call from another replica out of the local hub", async () => {
    startHostLink("live-1");
    const { ws } = await host;
    ws.send(JSON.stringify({ op: "rpc", id: "c1", method: "describe", args: [] }));
    expect(await nextMessage(ws)).toEqual({
      op: "rpc-result",
      id: "c1",
      ok: true,
      result: { organizationId: "org-1", host: "10.0.0.5", alreadyShared: null },
    });

    ws.send(
      JSON.stringify({ op: "rpc", id: "c2", method: "detach", args: ["p-1", "removed", "Bye"] }),
    );
    expect((await nextMessage(ws))["ok"]).toBe(true);
    expect(hub.detach).toHaveBeenCalledWith("live-1", "p-1", "removed", "Bye");
  });

  it("attaches a bridged guest to the hub and carries frames both ways", async () => {
    startHostLink("live-1");
    const { ws } = await host;
    ws.send(JSON.stringify({ op: "viewer-open", viewer: "v1", participantId: "p-1" }));
    await vi.waitFor(() => expect(hub.attach).toHaveBeenCalled());

    // The hub writes to the guest through the relayed socket.
    const attachedSocket = (
      hub.attach.mock.calls[0] as unknown as [{ ws: { send(d: string): void } }]
    )[0].ws;
    const toViewer = nextMessage(ws);
    attachedSocket.send(JSON.stringify({ type: "console:data", data: "aGk=" }));
    expect(await toViewer).toEqual({
      op: "to-viewer",
      viewer: "v1",
      data: JSON.stringify({ type: "console:data", data: "aGk=" }),
    });

    // The guest's keystrokes reach the hub as that participant.
    ws.send(
      JSON.stringify({
        op: "viewer-frame",
        viewer: "v1",
        data: JSON.stringify({ type: "console:input", data: "bHM=" }),
      }),
    );
    await vi.waitFor(() =>
      expect(hub.handleAttachedMessage).toHaveBeenCalledWith("live-1", "p-1", {
        type: "console:input",
        data: "bHM=",
      }),
    );
  });
});
