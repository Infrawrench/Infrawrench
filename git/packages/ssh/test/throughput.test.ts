/**
 * How fast bytes move through the server, per cipher and direction, with the
 * real OpenSSH client on the other end. Not part of the normal run:
 *
 *   SSH_BENCH=1 npx vitest run test/throughput.test.ts
 *
 * The numbers in NOTES.md come from this.
 */
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { open } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkspace,
  generateKey,
  MISSING_TOOLS,
  sshOptions,
  startServer,
  type KeyPair,
  type TestServer,
  type Workspace,
} from "./support";

const MIB = 1024 * 1024;
const SIZE = Number(process.env.SSH_BENCH_MIB ?? 512) * MIB;
const CIPHERS = [
  "aes128-gcm@openssh.com",
  "aes256-gcm@openssh.com",
  "chacha20-poly1305@openssh.com",
];

describe.skipIf(!process.env.SSH_BENCH || MISSING_TOOLS.length > 0)("throughput", () => {
  let workspace: Workspace;
  let server: TestServer;
  let user: KeyPair;
  let received = 0;
  const results: string[] = [];

  beforeAll(async () => {
    workspace = await createWorkspace();
    const hostKey = await generateKey(workspace, "host", "ed25519");
    user = await generateKey(workspace, "user", "ed25519");
    server = await startServer({
      hostKey: hostKey.privateKey,
      users: new Map([[user.publicKey.fingerprint, "bench"]]),
      exec: async (_principal, command, channel) => {
        if (command === "sink") {
          received = 0;
          for await (const chunk of channel.stdin) received += chunk.length;
          return 0;
        }
        const out = channel.stdout.getWriter();
        const block = new Uint8Array(64 * 1024);
        for (let sent = 0; sent < SIZE; sent += block.length) await out.write(block);
        await out.close();
        return 0;
      },
    });
    // A sparse file of zeros: the cost measured is the server's, not the disk's.
    const file = await open(workspace.path("input"), "w");
    await file.truncate(SIZE);
    await file.close();
  }, 60_000);

  afterAll(async () => {
    await server.close();
    await workspace.cleanup();
    process.stderr.write(`\n${results.join("\n")}\n`);
  });

  const run = (cipher: string, command: string, stdin: number | "ignore") =>
    new Promise<number>((resolve, reject) => {
      const started = performance.now();
      const child = spawn(
        "ssh",
        [...sshOptions(server.port, user.path, ["-c", cipher]), "git@127.0.0.1", command],
        { stdio: [stdin, "ignore", "inherit"] },
      );
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve((performance.now() - started) / 1000)
          : reject(new Error(`ssh exited ${code}`)),
      );
    });

  it.each(CIPHERS)(
    "%s",
    async (cipher) => {
      const input = openSync(workspace.path("input"), "r");
      try {
        const up = await run(cipher, "sink", input);
        expect(received).toBe(SIZE);
        const down = await run(cipher, "source", "ignore");
        const rate = (seconds: number) => `${(SIZE / MIB / seconds).toFixed(0)} MiB/s`;
        results.push(
          `${cipher.padEnd(30)} upload ${rate(up).padStart(10)}   download ${rate(down).padStart(10)}`,
        );
      } finally {
        closeSync(input);
      }
    },
    300_000,
  );
});
