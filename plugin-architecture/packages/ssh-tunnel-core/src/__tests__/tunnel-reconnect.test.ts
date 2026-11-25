/**
 * Tunnels against a real SSH server (ssh2's own, in process) reached through a
 * TCP proxy the test can cut, freeze or refuse, the way a bastion restarts,
 * hangs or goes away (#1276). The forwarded service is a local echo server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import ssh2 from "ssh2";
import type { Connection } from "ssh2";
import {
  SshTunnelUnavailableError,
  TUNNEL_KEEPALIVE_COUNT_MAX,
  TUNNEL_KEEPALIVE_INTERVAL_MS,
  closeAllTunnels,
  ensureTunnel,
  getTunnelEntries,
  type OpenTunnelOptions,
} from "../tunnels.js";

const { Server: SshServer, utils } = ssh2;

// ssh2 1.17's ed25519 generator strips every leading zero byte from the public
// key's DER bit string, not just the unused-bits byte, so a public key that
// starts with 0x00 (about 1 in 256) is written 31 bytes long and its own
// `parseKey` (and `new Server`) refuses the result. Draw again until it parses.
function ed25519Key(): string {
  for (;;) {
    const key = utils.generateKeyPairSync("ed25519").private;
    if (!(utils.parseKey(key) instanceof Error)) return key;
  }
}

const hostKey = ed25519Key();
const clientKey = ed25519Key();

function listen(server: net.Server | InstanceType<typeof SshServer>, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function closeServer(server: net.Server | InstanceType<typeof SshServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** The service behind the bastion: echoes every line back. */
const echo = net.createServer((socket) => {
  socket.on("error", () => {});
  socket.pipe(socket);
});
let echoPort = 0;

/** The bastion. `rejectForwards` makes it refuse every channel open. */
let rejectForwards = false;
const sshConnections = new Set<Connection>();
const sshd = new SshServer({ hostKeys: [hostKey] }, (conn) => {
  sshConnections.add(conn);
  conn.on("close", () => sshConnections.delete(conn));
  conn.on("error", () => {});
  conn.on("authentication", (ctx) => ctx.accept());
  conn.on("tcpip", (accept, reject, info) => {
    if (rejectForwards) {
      reject();
      return;
    }
    const upstream = net.connect(info.destPort, info.destIP);
    upstream.on("error", () => {});
    const channel = accept();
    channel.on("error", () => {});
    channel.pipe(upstream);
    upstream.pipe(channel);
    // Close each side with the other, as sshd does, rather than leaving it to
    // half-close: on CI's in-memory loopback a FIN can be the last thing that
    // moves, and the leak check would then wait on a socket nobody needs.
    channel.on("close", () => upstream.destroy());
    upstream.on("close", () => channel.close());
  });
});
let sshdPort = 0;

/**
 * What the tunnel dials: a proxy in front of the bastion. Closing it refuses
 * new connections; `cut` resets the open ones; `freeze` stops passing bytes
 * without closing anything (a silently dead network path).
 */
class Bastion {
  port = 0;
  private server: net.Server | null = null;
  private readonly links = new Set<{ inbound: net.Socket; outbound: net.Socket }>();

  async start(port = 0): Promise<void> {
    this.server = net.createServer((inbound) => {
      const outbound = net.connect(sshdPort, "127.0.0.1");
      const link = { inbound, outbound };
      this.links.add(link);
      const done = () => {
        inbound.destroy();
        outbound.destroy();
        this.links.delete(link);
      };
      inbound.on("error", done).on("close", done);
      outbound.on("error", done).on("close", done);
      inbound.pipe(outbound);
      outbound.pipe(inbound);
    });
    this.port = await listen(this.server, port);
  }

  async stop(): Promise<void> {
    this.cut();
    if (this.server) await closeServer(this.server);
    this.server = null;
  }

  cut(): void {
    for (const { inbound, outbound } of this.links) {
      inbound.destroy();
      outbound.destroy();
    }
  }

  freeze(): void {
    for (const { inbound, outbound } of this.links) {
      inbound.unpipe(outbound);
      outbound.unpipe(inbound);
      inbound.pause();
      outbound.pause();
    }
  }
}

const bastion = new Bastion();

function plan(options: OpenTunnelOptions = {}) {
  return () => ({
    config: {
      sshHost: "127.0.0.1",
      sshPort: bastion.port,
      sshUser: "test",
      privateKey: clientKey,
      remoteHost: "127.0.0.1",
      remotePort: echoPort,
    },
    extras: { accountId: "acct-1" },
    options: {
      ...options,
      configureConnect: (opts: ssh2.ConnectConfig) => {
        const configured = { ...opts, hostVerifier: () => true };
        return options.configureConnect ? options.configureConnect(configured) : configured;
      },
    },
  });
}

/** Sends `text` through the tunnel and resolves with what comes back, or how it ended. */
function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let got = "";
    socket.on("data", (chunk) => {
      got += chunk.toString();
      if (got.length >= text.length) {
        socket.end();
        resolve(got);
      }
    });
    socket.on("error", (err: NodeJS.ErrnoException) => resolve(`error ${err.code}`));
    socket.on("close", () => resolve(got.length >= text.length ? got : "closed"));
    socket.write(text);
  });
}

/**
 * Waits for `check`. The deadline reads `performance.now()`, which tests that
 * fake `Date` leave running, and sits inside vitest's own 5 s so a wait that
 * never ends fails here, saying which, rather than as a bare test timeout.
 */
async function until(
  check: () => boolean,
  ms = 4_000,
  what: () => string = () => check.toString(),
): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const tracked = () =>
  process
    .getActiveResourcesInfo()
    .filter((r) => r === "TCPServerWrap" || r === "TCPSocketWrap" || r === "Timeout");
const handles = () => tracked().length;

let baseline = 0;

beforeAll(async () => {
  echoPort = await listen(echo);
  sshdPort = await listen(sshd);
  await bastion.start();
  baseline = handles();
});

afterEach(async () => {
  vi.useRealTimers();
  rejectForwards = false;
  closeAllTunnels();
  await bastion.stop();
  await bastion.start(bastion.port);
});

afterAll(async () => {
  closeAllTunnels();
  await bastion.stop();
  for (const conn of sshConnections) conn.end();
  await closeServer(sshd);
  await closeServer(echo);
});

describe("tunnels whose SSH connection ends (#1276)", () => {
  it("keeps keepalives on, so a dead connection is noticed in bounded time", async () => {
    let seen: ssh2.ConnectConfig | undefined;
    await ensureTunnel("ka", plan({ configureConnect: (opts) => (seen = opts) }));
    expect(seen?.keepaliveInterval).toBe(TUNNEL_KEEPALIVE_INTERVAL_MS);
    expect(seen?.keepaliveCountMax).toBe(TUNNEL_KEEPALIVE_COUNT_MAX);
    expect(TUNNEL_KEEPALIVE_INTERVAL_MS * (TUNNEL_KEEPALIVE_COUNT_MAX + 1)).toBeLessThanOrEqual(
      60_000,
    );
  });

  it("drops a tunnel whose connection is cut, resets its users, and reopens on the next use", async () => {
    const first = await ensureTunnel("acct-1", plan());
    expect(await roundTrip(first.localPort, "ping\n")).toBe("ping\n");

    // A user mid-session when the bastion goes away.
    const inFlight = net.connect(first.localPort, "127.0.0.1");
    inFlight.on("error", () => {});
    const ended = new Promise<void>((resolve) => inFlight.on("close", () => resolve()));
    await new Promise((r) => inFlight.once("connect", r));
    await until(() => sshConnections.size > 0);

    bastion.cut();
    await until(() => getTunnelEntries().length === 0);
    await ended; // closed, not left hanging
    expect(await roundTrip(first.localPort, "x")).toBe("error ECONNREFUSED");

    // Within the stable window, so the next use waits a moment first.
    await expect(ensureTunnel("acct-1", plan())).rejects.toBeInstanceOf(SshTunnelUnavailableError);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 1_500 });

    const second = await ensureTunnel("acct-1", plan());
    expect(second.tunnelId).not.toBe(first.tunnelId);
    expect(await roundTrip(second.localPort, "pong\n")).toBe("pong\n");
    expect(getTunnelEntries()).toHaveLength(1);
  });

  it("reopens straight away when a tunnel that had been up a while drops", async () => {
    const first = await ensureTunnel("acct-1", plan());
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    bastion.cut();
    await until(() => getTunnelEntries().length === 0);
    const second = await ensureTunnel("acct-1", plan());
    expect(second.localPort).not.toBe(0);
    expect(second.tunnelId).not.toBe(first.tunnelId);
    expect(await roundTrip(second.localPort, "again\n")).toBe("again\n");
  });

  it("backs off while the bastion refuses, with a clear error, then recovers", async () => {
    await bastion.stop();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });

    await expect(ensureTunnel("down", plan())).rejects.toThrow(
      /SSH connection failed: connect ECONNREFUSED/,
    );
    // Within the wait: refused without dialling, naming the cause.
    const waiting = ensureTunnel("down", plan());
    await expect(waiting).rejects.toBeInstanceOf(SshTunnelUnavailableError);
    await expect(waiting).rejects.toThrow(/ECONNREFUSED.*trying again in 1s/);

    // Past it: dials, fails again, waits twice as long.
    vi.setSystemTime(start + 1_100);
    await expect(ensureTunnel("down", plan())).rejects.toThrow(/ECONNREFUSED/);
    vi.setSystemTime(start + 2_200);
    await expect(ensureTunnel("down", plan())).rejects.toThrow(/trying again in 1s/);
    vi.setSystemTime(start + 3_200);
    await expect(ensureTunnel("down", plan())).rejects.toThrow(/SSH connection failed/);
    vi.setSystemTime(start + 3_300);
    await expect(ensureTunnel("down", plan())).rejects.toThrow(/trying again in 4s/);

    // The bastion comes back.
    await bastion.start(bastion.port);
    vi.setSystemTime(start + 8_000);
    const tunnel = await ensureTunnel("down", plan());
    expect(await roundTrip(tunnel.localPort, "back\n")).toBe("back\n");
  });

  it("drops a silently dead connection once keepalives go unanswered", async () => {
    const tunnel = await ensureTunnel(
      "frozen",
      plan({ configureConnect: (opts) => ({ ...opts, keepaliveInterval: 50 }) }),
    );
    const inFlight = net.connect(tunnel.localPort, "127.0.0.1");
    inFlight.on("error", () => {});
    const ended = new Promise<void>((resolve) => inFlight.on("close", () => resolve()));
    await new Promise((r) => inFlight.once("connect", r));

    bastion.freeze();
    await until(() => getTunnelEntries().length === 0, 2_000);
    await ended;
  });

  it("drops a tunnel whose forwarded channels keep failing", async () => {
    const tunnel = await ensureTunnel("rejecting", plan());
    rejectForwards = true;
    for (let i = 0; i < 3; i++) {
      expect(await roundTrip(tunnel.localPort, "x")).toBe("closed");
    }
    await until(() => getTunnelEntries().length === 0);
    await expect(ensureTunnel("rejecting", plan())).rejects.toThrow(
      /forwarding to 127\.0\.0\.1:\d+ failed 3 times in a row/,
    );
  });

  it("opens once for concurrent callers of a key", async () => {
    const opened = vi.fn();
    const both = await Promise.all([
      ensureTunnel("shared", () => (opened(), plan()())),
      ensureTunnel("shared", () => (opened(), plan()())),
    ]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(both[0]).toEqual(both[1]);
    expect(getTunnelEntries()).toHaveLength(1);
  });

  it("leaves no listener, socket or timer behind", async () => {
    const tunnel = await ensureTunnel("leak", plan());
    expect(await roundTrip(tunnel.localPort, "a\n")).toBe("a\n");
    bastion.cut();
    await until(() => getTunnelEntries().length === 0);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    const again = await ensureTunnel("leak", plan());
    expect(await roundTrip(again.localPort, "b\n")).toBe("b\n");
    closeAllTunnels();
    await bastion.stop();
    await bastion.start(bastion.port);
    await until(() => sshConnections.size === 0);
    // At most the baseline: on CI's runner the baseline can hold a timer of
    // vitest's own that is gone by now, so equality would never come.
    await until(
      () => handles() <= baseline,
      4_000,
      () => `at most ${baseline} handles, still open: ${tracked().join(", ")}`,
    );
  });
});
