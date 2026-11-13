/**
 * `HostServices.ssh` against real SSH servers on the loopback (ssh2's own
 * server): a script runs on the account's host, through its jump host, only
 * when every host key is the one the organization pinned.
 */
import * as net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ssh2 from "ssh2";
import { sha256Fingerprint } from "@infrawrench/ssh-tunnel-core";

vi.mock("../db/client", () => ({ db: {} }));
// The loopback is what the egress guard exists to refuse; these servers live there.
vi.mock("../egress-guard", () => ({ resolveSafeHost: async (host: string) => host }));

const { connectPinned, execOnAccountHost } = await import("../ssh-exec");

type Server = InstanceType<typeof ssh2.Server>;

function keyPair() {
  return ssh2.utils.generateKeyPairSync("ed25519");
}

function hostKeyFingerprint(privateKey: string): string {
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0]! : parsed;
  return sha256Fingerprint(key.getPublicSSH());
}

/** An SSH server that runs `sh -s` scripts as an echo of their input, and forwards tcpip. */
async function server(
  name: string,
): Promise<{ server: Server; port: number; fingerprint: string }> {
  const host = keyPair();
  const srv = new ssh2.Server({ hostKeys: [host.private] }, (client) => {
    // A client that refuses this host's key ends the exchange: expected here.
    client.on("error", () => {});
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          let input = "";
          stream.on("data", (d: Buffer) => (input += d.toString()));
          stream.on("end", () => {
            stream.write(`${name} ran ${info.command}: ${input}`);
            stream.exit(0);
            stream.end();
          });
        });
      });
      client.on("tcpip", (accept, _reject, info) => {
        const upstream = net.connect(info.destPort, info.destIP, () => {
          const channel = accept();
          channel.pipe(upstream);
          upstream.pipe(channel);
        });
      });
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return {
    server: srv,
    port: (srv.address() as net.AddressInfo).port,
    fingerprint: hostKeyFingerprint(host.private),
  };
}

// Real sockets and ssh2's own server; where Node itself is WebAssembly
// (Infrawrench CI's runner) the key exchange's native crypto is not all there.
describe.skipIf((process.platform as string) === "wasi")("running a script on an SSH host", () => {
  let jump: Awaited<ReturnType<typeof server>>;
  let target: Awaited<ReturnType<typeof server>>;
  const user = keyPair();

  beforeAll(async () => {
    jump = await server("jump");
    target = await server("target");
  });
  afterAll(() => {
    jump.server.close();
    target.server.close();
  });

  const config = (port: number) => ({
    host: "127.0.0.1",
    port,
    username: "ci",
    privateKey: user.private,
  });
  const pinsFor = (pinned: Record<number, string>) => async (_host: string, port: number) =>
    pinned[port] ?? null;

  it("runs the script on stdin when the host key is the pinned one", async () => {
    const out = await execOnAccountHost(
      "org",
      "target",
      "echo hi",
      10_000,
      async () => ({ config: config(target.port) }),
      pinsFor({ [target.port]: target.fingerprint }),
    );
    expect(out).toBe("target ran sh -s: echo hi");
  });

  it("goes through the jump host, checking both keys", async () => {
    const out = await execOnAccountHost(
      "org",
      "target",
      "uname",
      10_000,
      async (id) =>
        id === "target"
          ? { config: config(target.port), throughAccountId: "jump" }
          : { config: config(jump.port) },
      pinsFor({ [target.port]: target.fingerprint, [jump.port]: jump.fingerprint }),
    );
    expect(out).toBe("target ran sh -s: uname");
  });

  it("refuses a host with no pinned key, or a changed one, naming the fingerprint", async () => {
    await expect(
      connectPinned(
        "org",
        config(target.port),
        undefined,
        async () => ({ config: config(0) }),
        pinsFor({}),
      ),
    ).rejects.toThrow(
      `No host key is pinned for 127.0.0.1:${target.port} (presented ${target.fingerprint})`,
    );
    await expect(
      connectPinned(
        "org",
        config(target.port),
        undefined,
        async () => ({ config: config(0) }),
        pinsFor({ [target.port]: jump.fingerprint }),
      ),
    ).rejects.toThrow("changed");
  });

  it("refuses an unpinned jump host before reaching the target", async () => {
    await expect(
      execOnAccountHost(
        "org",
        "target",
        "x",
        10_000,
        async (id) =>
          id === "target"
            ? { config: config(target.port), throughAccountId: "jump" }
            : { config: config(jump.port) },
        pinsFor({ [target.port]: target.fingerprint }),
      ),
    ).rejects.toThrow(`No host key is pinned for 127.0.0.1:${jump.port}`);
  });
});
