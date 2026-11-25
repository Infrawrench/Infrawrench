/**
 * The real OpenSSH client against the server: authentication with every key
 * type, each cipher, re-keying, the shell greeting, and everything that is
 * refused.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collect,
  createWorkspace,
  generateKey,
  MISSING_TOOLS,
  sleep,
  ssh,
  sshOptions,
  startServer,
  type ExecHandler,
  type KeyPair,
  type TestServer,
  type Workspace,
} from "./support";

const encoder = new TextEncoder();

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of stream) total += chunk.length;
  return total;
}

/** A handful of commands that exercise the channel without involving git. */
const exec: ExecHandler = async (principal, command, channel, env) => {
  const out = channel.stdout.getWriter();
  const [verb, argument] = command.split(" ");
  switch (verb) {
    case "whoami":
      await out.write(encoder.encode(`${principal}\n`));
      await out.close();
      return 0;
    case "env":
      await out.write(encoder.encode(JSON.stringify([...env])));
      await out.close();
      return 0;
    case "echo":
      // Copies stdin to stdout, in whatever chunks arrive.
      out.releaseLock();
      await channel.stdin.pipeTo(channel.stdout);
      return 0;
    case "count": {
      const total = await drain(channel.stdin);
      await out.write(encoder.encode(String(total)));
      await out.close();
      return 0;
    }
    case "produce": {
      // Deterministic bytes, so the client can check every one of them.
      const size = Number(argument);
      const block = new Uint8Array(64 * 1024);
      for (let sent = 0; sent < size; sent += block.length) {
        for (let i = 0; i < block.length; i++) block[i] = (sent + i) % 251;
        await out.write(block.slice(0, Math.min(block.length, size - sent)));
      }
      await out.close();
      return 0;
    }
    case "both": {
      const err = channel.stderr.getWriter();
      await out.write(encoder.encode("to stdout\n"));
      await err.write(encoder.encode("to stderr\n"));
      await out.close();
      await err.close();
      return 0;
    }
    case "exit":
      await out.close();
      return Number(argument);
    case "throw":
      throw new Error("handler failed");
    case "hang":
      await new Promise((_resolve, reject) =>
        channel.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      return 0;
    default:
      return 127;
  }
};

function expectedBytes(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = i % 251;
  return out;
}

describe.skipIf(MISSING_TOOLS.length > 0)("OpenSSH client interop", () => {
  let workspace: Workspace;
  let server: TestServer;
  let hostKey: KeyPair;
  const keys: Record<string, KeyPair> = {};
  let stranger: KeyPair;

  beforeAll(async () => {
    workspace = await createWorkspace();
    hostKey = await generateKey(workspace, "host", "ed25519");
    keys.ed25519 = await generateKey(workspace, "user-ed25519", "ed25519");
    keys.ecdsa256 = await generateKey(workspace, "user-ecdsa256", "ecdsa", 256);
    keys.ecdsa384 = await generateKey(workspace, "user-ecdsa384", "ecdsa", 384);
    keys.ecdsa521 = await generateKey(workspace, "user-ecdsa521", "ecdsa", 521);
    keys.rsa = await generateKey(workspace, "user-rsa", "rsa", 3072);
    stranger = await generateKey(workspace, "stranger", "ed25519");
    const users = new Map(
      Object.entries(keys).map(([name, key]) => [key.publicKey.fingerprint, name]),
    );
    server = await startServer({ hostKey: hostKey.privateKey, users, exec });
  }, 60_000);

  afterAll(async () => {
    await server.close();
    await workspace.cleanup();
  });

  const key = (name: string): KeyPair => keys[name]!;

  it.each(["ed25519", "ecdsa256", "ecdsa384", "ecdsa521", "rsa"])(
    "authenticates a %s key and runs a command",
    async (name) => {
      const summary = server.nextSummary();
      const result = await ssh(server.port, key(name).path, ["whoami"]);
      expect(result.stderr).toBe("");
      expect(result.stdout.toString()).toBe(`${name}\n`);
      expect(result.code).toBe(0);
      const ended = await summary;
      expect(ended).toMatchObject({
        authenticated: true,
        strictKex: true,
        // What a current OpenSSH prefers, and the server has it.
        keyExchange: "mlkem768x25519-sha256",
        error: null,
      });
      expect(ended.clientVersion).toMatch(/^SSH-2\.0-OpenSSH/);
    },
  );

  it("does not make the client warn about a key exchange that is not post-quantum", async () => {
    // At the default log level, where OpenSSH 10 prints that warning.
    const child = spawn("ssh", [
      ...sshOptions(server.port, key("ed25519").path, ["-o", "LogLevel=INFO"]),
      "git@127.0.0.1",
      "whoami",
    ]);
    const result = await collect(child);
    expect(result.stdout.toString()).toBe("ed25519\n");
    expect(result.stderr).not.toMatch(/post-quantum/);
  });

  it.each(["curve25519-sha256", "curve25519-sha256@libssh.org", "mlkem768x25519-sha256"])(
    "exchanges keys with %s, and again on every re-key",
    async (kex) => {
      const summary = server.nextSummary();
      const payload = randomBytes(4 * 1024 * 1024);
      const result = await ssh(
        server.port,
        key("ed25519").path,
        ["-o", `KexAlgorithms=${kex}`, "-o", "RekeyLimit=1M", "echo"],
        payload,
      );
      expect(result.stdout.equals(payload)).toBe(true);
      const ended = await summary;
      expect(ended.keyExchange).toBe(kex);
      expect(ended.keyExchanges).toBeGreaterThan(3);
    },
  );

  it("presents the host key the server was given", async () => {
    const known = workspace.path("known_hosts");
    const result = await collect(
      spawn("ssh", [
        ...sshOptions(server.port, key("ed25519").path, [
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${known}`,
        ]),
        "git@127.0.0.1",
        "whoami",
      ]),
    );
    expect(result.code).toBe(0);
    const { readFile } = await import("node:fs/promises");
    const recorded = (await readFile(known, "utf8")).trim().split(" ").slice(1, 3).join(" ");
    expect(recorded).toBe(hostKey.publicLine.split(" ").slice(0, 2).join(" "));
  });

  it("asks before it verifies: a query, then a verified lookup", async () => {
    server.lookups.length = 0;
    await ssh(server.port, key("ed25519").path, ["whoami"]);
    expect(server.lookups.map((lookup) => lookup.phase)).toEqual(["query", "verified"]);
    expect(server.lookups[0]).toMatchObject({
      user: "git",
      algorithm: "ssh-ed25519",
      fingerprint: key("ed25519").publicKey.fingerprint,
    });
  });

  it("refuses a key nobody registered", async () => {
    const summary = server.nextSummary();
    const result = await ssh(server.port, stranger.path, ["whoami"]);
    expect(result.code).toBe(255);
    expect(result.stderr).toMatch(/Permission denied \(publickey\)/);
    expect(result.stdout.length).toBe(0);
    expect((await summary).authenticated).toBe(false);
  });

  it("refuses ssh-rsa (SHA-1) signatures but takes the same key with SHA-2", async () => {
    server.lookups.length = 0;
    const sha1 = await ssh(server.port, key("rsa").path, [
      "-o",
      "PubkeyAcceptedAlgorithms=ssh-rsa",
      "-v",
      "whoami",
    ]);
    expect(sha1.code).toBe(255);
    expect(sha1.stderr).toMatch(/Permission denied \(publickey\)/);
    // The server's list of signature algorithms leaves SHA-1 out, so the
    // client does not even try. (protocol.test.ts sends one regardless.)
    expect(sha1.stderr).toMatch(/Skipping ssh-rsa key .* not supported by server/);
    expect(server.lookups).toEqual([]);

    for (const algorithm of ["rsa-sha2-256", "rsa-sha2-512"]) {
      const result = await ssh(server.port, key("rsa").path, [
        "-o",
        `PubkeyAcceptedAlgorithms=${algorithm}`,
        "whoami",
      ]);
      expect(result.stdout.toString()).toBe("rsa\n");
    }
  });

  it.each(["aes256-gcm@openssh.com", "aes128-gcm@openssh.com", "chacha20-poly1305@openssh.com"])(
    "carries data both ways under %s",
    async (cipher) => {
      const summary = server.nextSummary();
      const payload = randomBytes(3 * 1024 * 1024 + 17);
      const echoed = await ssh(server.port, key("ed25519").path, ["-c", cipher, "echo"], payload);
      expect(echoed.code).toBe(0);
      expect(echoed.stdout.equals(payload)).toBe(true);
      expect((await summary).cipher).toBe(cipher);
    },
  );

  it("lets the client's order decide between ciphers both sides have", async () => {
    const summary = server.nextSummary();
    await ssh(server.port, key("ed25519").path, [
      "-c",
      "chacha20-poly1305@openssh.com,aes128-gcm@openssh.com",
      "whoami",
    ]);
    expect((await summary).cipher).toBe("chacha20-poly1305@openssh.com");
  });

  it.each(["aes128-gcm@openssh.com", "chacha20-poly1305@openssh.com"])(
    "re-keys when the client asks, under %s",
    async (cipher) => {
      const summary = server.nextSummary();
      const size = 12 * 1024 * 1024;
      const result = await ssh(server.port, key("ed25519").path, [
        "-c",
        cipher,
        "-o",
        "RekeyLimit=1M",
        `produce ${size}`,
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout.equals(expectedBytes(size))).toBe(true);
      expect((await summary).keyExchanges).toBeGreaterThan(5);

      const upload = server.nextSummary();
      const payload = randomBytes(8 * 1024 * 1024);
      const counted = await ssh(
        server.port,
        key("ed25519").path,
        ["-c", cipher, "-o", "RekeyLimit=1M", "echo"],
        payload,
      );
      expect(counted.stdout.equals(payload)).toBe(true);
      expect((await upload).keyExchanges).toBeGreaterThan(5);
    },
  );

  it("separates stdout from stderr and reports the exit status", async () => {
    const both = await ssh(server.port, key("ed25519").path, ["both"]);
    expect(both.stdout.toString()).toBe("to stdout\n");
    expect(both.stderr).toBe("to stderr\n");
    expect((await ssh(server.port, key("ed25519").path, ["exit 42"])).code).toBe(42);
    expect((await ssh(server.port, key("ed25519").path, ["nonsense"])).code).toBe(127);
  });

  it("reports a handler that throws as a failed command, and to the host", async () => {
    server.errors.length = 0;
    const result = await ssh(server.port, key("ed25519").path, ["throw"]);
    expect(result.code).toBe(1);
    expect(server.errors).toHaveLength(1);
    // Nothing about the failure reaches the client.
    expect(result.stderr).toBe("");
  });

  it("collects environment variables the client sends", async () => {
    const child = spawn(
      "ssh",
      [
        ...sshOptions(server.port, key("ed25519").path, ["-o", "SendEnv=GIT_PROTOCOL"]),
        "git@127.0.0.1",
        "env",
      ],
      { env: { ...process.env, GIT_PROTOCOL: "version=2" } },
    );
    const result = await collect(child);
    expect(JSON.parse(result.stdout.toString())).toEqual([["GIT_PROTOCOL", "version=2"]]);
  });

  it("answers a shell request with the greeting and exit status 1", async () => {
    const result = await ssh(server.port, key("ed25519").path, ["-T", ""]);
    expect(result.stdout.toString()).toBe(
      "Hi ed25519! You've successfully authenticated, but shell access is not provided.\n",
    );
    expect(result.code).toBe(1);
  });

  it("refuses a PTY and still greets", async () => {
    // `script` gives ssh a terminal, so it asks for a PTY the way it does for a person.
    const argv = [...sshOptions(server.port, key("ed25519").path), "git@127.0.0.1"];
    const child =
      process.platform === "darwin"
        ? spawn("script", ["-q", "/dev/null", "ssh", ...argv], {
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn("script", ["-qec", ["ssh", ...argv].join(" "), "/dev/null"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
    const result = await collect(child);
    const output = result.stdout.toString();
    expect(output).toMatch(/PTY allocation request failed on channel 0/);
    expect(output).toMatch(/Hi ed25519! You've successfully authenticated/);
  });

  it("refuses subsystems", async () => {
    const result = await ssh(server.port, key("ed25519").path, ["-s", "sftp"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/subsystem request failed/i);
  });

  it("refuses remote port forwarding", async () => {
    const result = await ssh(server.port, key("ed25519").path, [
      "-o",
      "ExitOnForwardFailure=yes",
      "-R",
      "0:127.0.0.1:9",
      "whoami",
    ]);
    expect(result.code).toBe(255);
    expect(result.stderr).toMatch(/remote port forwarding failed/i);
  });

  it("refuses local port forwarding channels", async () => {
    // -W asks for a direct-tcpip channel and nothing else.
    const result = await ssh(server.port, key("ed25519").path, ["-W", "127.0.0.1:9", ""]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/open failed|forwarding/i);
  });

  it("refuses to forward the agent and still runs the command", async () => {
    const socket = workspace.path("agent.sock");
    const agent = spawn("ssh-agent", ["-D", "-a", socket], { stdio: "ignore" });
    try {
      const { existsSync } = await import("node:fs");
      for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt++) await sleep(20);
      const child = spawn(
        "ssh",
        [
          ...sshOptions(server.port, key("ed25519").path, [
            "-A",
            "-o",
            `IdentityAgent=${socket}`,
            "-v",
          ]),
          "git@127.0.0.1",
          "whoami",
        ],
        { env: { ...process.env, SSH_AUTH_SOCK: socket } },
      );
      const result = await collect(child);
      expect(result.stderr).toMatch(/Requesting agent forwarding on channel 0/);
      expect(result.stdout.toString()).toBe("ed25519\n");
      expect(result.code).toBe(0);
    } finally {
      agent.kill();
    }
  });

  it("runs several sessions over one connection", async () => {
    const control = workspace.path("control.sock");
    const master = spawn("ssh", [
      ...sshOptions(server.port, key("ed25519").path, ["-M", "-S", control, "-N"]),
      "git@127.0.0.1",
    ]);
    // Registered now: the master may be gone before the code below gets round to waiting for it.
    const masterClosed = new Promise((resolve) => master.on("close", resolve));
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const check = await collect(spawn("ssh", ["-S", control, "-O", "check", "git@127.0.0.1"]));
        if (check.code === 0) break;
        await sleep(50);
      }
      const before = server.summaries.length;
      const results = await Promise.all(
        ["whoami", "exit 3", "produce 500000", "whoami"].map((command) =>
          collect(spawn("ssh", ["-S", control, "git@127.0.0.1", command])),
        ),
      );
      expect(results.map((result) => result.code)).toEqual([0, 3, 0, 0]);
      expect(results[0]!.stdout.toString()).toBe("ed25519\n");
      expect(results[2]!.stdout.equals(expectedBytes(500000))).toBe(true);
      // All four ran on the master's connection: none of them has ended one.
      expect(server.summaries.length).toBe(before);
    } finally {
      await collect(spawn("ssh", ["-S", control, "-O", "exit", "git@127.0.0.1"]));
      await masterClosed;
    }
  });

  it("aborts the command when the client goes away", async () => {
    const summary = server.nextSummary();
    const child = spawn("ssh", [
      ...sshOptions(server.port, key("ed25519").path),
      "git@127.0.0.1",
      "hang",
    ]);
    await sleep(700);
    child.kill("SIGKILL");
    // The summary only arrives once the handler has seen the abort and returned.
    const ended = await summary;
    expect(ended.authenticated).toBe(true);
  });
});
