import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Fake ssh2 Client driven by the test. `connect()` records its config and the
// test emits "ready"/"error". `forwardOut` invokes its callback with whatever
// the test stubs.
const forwardOutMock = vi.fn();
const endMock = vi.fn();
const connectMock = vi.fn();

class FakeSshClient extends EventEmitter {
  connect = connectMock;
  end = endMock;
  forwardOut = forwardOutMock;
}

let lastClient: FakeSshClient | undefined;

vi.mock("ssh2", () => ({
  Client: vi.fn(function () {
    lastClient = new FakeSshClient();
    return lastClient;
  }),
  BaseAgent: class {},
  utils: { parseKey: vi.fn() },
}));

import {
  openTunnel,
  closeTunnel,
  closeAllTunnels,
  getTunnelEntries,
  findTunnel,
} from "../index.js";

const baseConfig = {
  sshHost: "ssh.example.com",
  sshPort: 22,
  sshUser: "ubuntu",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
  remoteHost: "10.0.0.5",
  remotePort: 5432,
};

/** Open a tunnel and drive the fake client to "ready" so it resolves. */
async function openReady<E>(extras: E) {
  const promise = openTunnel(baseConfig, extras);
  // let connect() run, then emit ready on the just-created client
  await Promise.resolve();
  lastClient!.emit("ready");
  return promise;
}

describe("tunnel lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeAllTunnels();
  });

  it("opens a tunnel, listens on an ephemeral local port, and tracks it", async () => {
    const { tunnelId, localPort } = await openReady({ organizationId: "o1", accountId: "a1" });
    expect(tunnelId).toMatch(/[0-9a-f-]{36}/);
    expect(localPort).toBeGreaterThan(0);

    const entries = getTunnelEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sshHost).toBe("ssh.example.com");
    expect(entries[0]!.remotePort).toBe(5432);
    expect(entries[0]!.extras).toEqual({ organizationId: "o1", accountId: "a1" });
  });

  it("forwardOut wires socket↔channel piping on a new local connection (success)", async () => {
    await openReady(undefined);
    const { localPort } = getTunnelEntries()[0]!;

    // grab the connection handler registered on the net server
    const server = getTunnelEntries()[0]!.server;

    // fake a channel + socket and drive a successful forwardOut
    const channel = new EventEmitter() as any;
    channel.pipe = vi.fn();
    channel.end = vi.fn();
    forwardOutMock.mockImplementationOnce((_h, _p, rh, rp, cb) => {
      expect(rh).toBe("10.0.0.5");
      expect(rp).toBe(5432);
      cb(null, channel);
    });

    const socket = new EventEmitter() as any;
    socket.pipe = vi.fn();
    socket.destroy = vi.fn();

    // emit a connection on the server to trigger the createServer callback
    server.emit("connection", socket);
    expect(forwardOutMock).toHaveBeenCalledTimes(1);
    expect(socket.pipe).toHaveBeenCalledWith(channel);
    expect(channel.pipe).toHaveBeenCalledWith(socket);

    // closing the socket should end the channel, and vice versa
    socket.emit("close");
    expect(channel.end).toHaveBeenCalled();
    channel.emit("close");
    expect(socket.destroy).toHaveBeenCalled();

    void localPort;
  });

  it("destroys the socket when forwardOut errors", async () => {
    await openReady(undefined);
    const server = getTunnelEntries()[0]!.server;

    forwardOutMock.mockImplementationOnce((_h, _p, _rh, _rp, cb) => {
      cb(new Error("channel open failed"), undefined);
    });

    const socket = new EventEmitter() as any;
    socket.destroy = vi.fn();
    socket.pipe = vi.fn();
    server.emit("connection", socket);
    expect(socket.destroy).toHaveBeenCalled();
    expect(socket.pipe).not.toHaveBeenCalled();
  });

  it("rejects and closes the server when the client errors before ready", async () => {
    const promise = openTunnel(baseConfig, undefined);
    await Promise.resolve();
    lastClient!.emit("error", new Error("auth failed"));
    await expect(promise).rejects.toThrow(/SSH connection failed: auth failed/);
    expect(getTunnelEntries()).toHaveLength(0);
  });

  it("closeTunnel closes the server, ends the client, and removes the record", async () => {
    const { tunnelId } = await openReady(undefined);
    expect(getTunnelEntries()).toHaveLength(1);
    closeTunnel(tunnelId);
    expect(endMock).toHaveBeenCalledTimes(1);
    expect(getTunnelEntries()).toHaveLength(0);
  });

  it("closeTunnel is a no-op for an unknown id", () => {
    expect(() => closeTunnel("does-not-exist")).not.toThrow();
    expect(endMock).not.toHaveBeenCalled();
  });

  it("closeAllTunnels tears down every tracked tunnel", async () => {
    await openReady(undefined);
    await openReady(undefined);
    expect(getTunnelEntries()).toHaveLength(2);
    closeAllTunnels();
    expect(getTunnelEntries()).toHaveLength(0);
    expect(endMock).toHaveBeenCalledTimes(2);
  });

  it("findTunnel returns a matching record or null", async () => {
    await openReady({ organizationId: "org-x", accountId: "acc-y" });
    const found = findTunnel<{ organizationId: string; accountId: string }>(
      (r) => r.extras.organizationId === "org-x",
    );
    expect(found).not.toBeNull();
    expect(found!.extras.accountId).toBe("acc-y");

    const missing = findTunnel((r) => (r.extras as any)?.organizationId === "nope");
    expect(missing).toBeNull();
  });
});
