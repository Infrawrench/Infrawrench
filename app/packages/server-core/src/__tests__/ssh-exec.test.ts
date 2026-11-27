/**
 * `HostServices.ssh` against real SSH servers on the loopback (ssh2's own
 * server): a script runs on the account's host, through its jump host, only
 * when every host key is the one the organization pinned, and the host's key
 * is handed out only when it is the pinned one.
 */
import * as net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ssh2 from "ssh2";
import { sha256Fingerprint } from "@infrawrench/ssh-tunnel-core";

vi.mock("../db/client", () => ({ db: {} }));
// The loopback is what the egress guard exists to refuse; these servers live there.
vi.mock("../egress-guard", () => ({ resolveSafeHost: async (host: string) => host }));

const { connectPinned, execOnAccountHost, hostKeyOfAccountHost } = await import("../ssh-exec");

type Server = InstanceType<typeof ssh2.Server>;

// ssh2 1.17's ed25519 generator strips every leading zero byte from the public
// key's DER bit string, not just the unused-bits byte, so a public key that
// starts with 0x00 (about 1 in 256) is written 31 bytes long and its own
// `parseKey` (and `new Server`) refuses the result. Draw again until it parses.
function keyPair() {
  for (;;) {
    const pair = ssh2.utils.generateKeyPairSync("ed25519");
    if (!(ssh2.utils.parseKey(pair.private) instanceof Error)) return pair;
  }
}

function hostKeyFingerprint(privateKey: string): string {
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0]! : parsed;
  return sha256Fingerprint(key.getPublicSSH());
}

/** An SSH server that runs `sh -s` scripts as an echo of their input, and forwards tcpip. */
async function server(name: string): Promise<{
  server: Server;
  port: number;
  fingerprint: string;
  publicKey: string;
  logins: () => number;
}> {
  const host = keyPair();
  let logins = 0;
  const srv = new ssh2.Server({ hostKeys: [host.private] }, (client) => {
    // A client that refuses this host's key ends the exchange: expected here.
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      logins += 1;
      ctx.accept();
    });
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
    publicKey: host.public.split(" ").slice(0, 2).join(" "),
    logins: () => logins,
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

  // A CI job lent the host gets its key as a `known_hosts` line (#1196).
  it("reads the pinned host's key without logging in to it", async () => {
    const before = target.logins();
    const key = await hostKeyOfAccountHost(
      "org",
      "target",
      async () => ({ config: config(target.port) }),
      pinsFor({ [target.port]: target.fingerprint }),
    );
    expect(key).toBe(target.publicKey);
    expect(key).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
    expect(target.logins()).toBe(before);
  });

  it("reads a host's key through its jump host, checking the jump host's", async () => {
    const resolve = async (id: string) =>
      id === "target"
        ? { config: config(target.port), throughAccountId: "jump" }
        : { config: config(jump.port) };
    const key = await hostKeyOfAccountHost(
      "org",
      "target",
      resolve,
      pinsFor({ [target.port]: target.fingerprint, [jump.port]: jump.fingerprint }),
    );
    expect(key).toBe(target.publicKey);
    await expect(
      hostKeyOfAccountHost(
        "org",
        "target",
        resolve,
        pinsFor({ [target.port]: target.fingerprint }),
      ),
    ).rejects.toThrow(`No host key is pinned for 127.0.0.1:${jump.port}`);
  });

  it("refuses to hand out a key that is not pinned, or not the pinned one", async () => {
    const resolve = async () => ({ config: config(target.port) });
    await expect(hostKeyOfAccountHost("org", "target", resolve, pinsFor({}))).rejects.toThrow(
      `No host key is pinned for 127.0.0.1:${target.port} (presented ${target.fingerprint})`,
    );
    await expect(
      hostKeyOfAccountHost("org", "target", resolve, pinsFor({ [target.port]: jump.fingerprint })),
    ).rejects.toThrow("changed");
  });
});
