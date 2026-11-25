/**
 * Starts the test worker (`./entry.ts`) in workerd through `wrangler dev`,
 * with local R2, Durable Objects and queues in a throwaway directory, an
 * HTTP port and a TCP port for SSH. Everything stays on 127.0.0.1 and
 * nothing is deployed or signed in.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "./entry";
import { run, tempDir } from "../support/git";

export const JOB_TOKEN_KEY = "test-job-token-key-0123456789abcdef-0123456789abcdef";

const WORKER_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const hasSsh =
  spawnSync("ssh", ["-V"]).status === 0 && spawnSync("ssh-keygen", ["-?"]).error === undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface SshKey {
  /** Path of the private key file. */
  readonly path: string;
  /** `SHA256:...` */
  readonly fingerprint: string;
}

/** A new ed25519 key pair in a temporary directory. */
export async function generateKey(label: string): Promise<SshKey> {
  const path = join(tempDir(`key-${label}`), "id_ed25519");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", label, "-f", path]);
  const listed = await run("ssh-keygen", ["-lf", `${path}.pub`]);
  return { path, fingerprint: listed.stdout.split(" ")[1]! };
}

export interface TestWorker {
  readonly httpUrl: string;
  readonly sshPort: number;
  /** `ssh://git@127.0.0.1:<port>/<owner>/<name>.git` */
  sshUrl(path: string): string;
  /** `GIT_SSH_COMMAND` for a client that signs in with `key`. */
  sshCommand(key: SshKey): string;
  /** Calls a `RepoClient` method on a repository's Durable Object. */
  rpc<T>(repoId: string, method: string, ...args: unknown[]): Promise<T>;
  /** Push events the queue has delivered, oldest first. */
  events(): Promise<Array<{ repoId: string; updates: Array<{ name: string; forced: boolean }> }>>;
  /** Resident memory of the workerd processes, in bytes. */
  memory(): number;
  /** What wrangler and the worker printed. */
  output(): string;
  stop(): Promise<void>;
}

/** Descendants of a process, itself included. */
function processTree(pid: number): number[] {
  const all = [pid];
  for (let i = 0; i < all.length; i++) {
    const children = spawnSync("pgrep", ["-P", String(all[i])], { encoding: "utf8" }).stdout;
    for (const line of children.split("\n")) if (line.trim() !== "") all.push(Number(line));
  }
  return all;
}

export async function startWorker(
  fixture: Fixture,
  options: { sshMaxFailures?: number } = {},
): Promise<TestWorker> {
  const dir = tempDir("wrangler");
  const [httpPort, sshPort, inspectorPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  const hostKeyPath = join(dir, "host_ed25519");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test-host", "-f", hostKeyPath]);
  const config = {
    name: "infrawrench-git-test",
    main: join(WORKER_ROOT, "test/e2e/entry.ts"),
    compatibility_date: "2026-11-20",
    compatibility_flags: ["nodejs_compat", "webcrypto_modern_algorithms"],
    limits: { cpu_ms: 300000 },
    vars: {
      FIXTURE: JSON.stringify(fixture),
      SSH_HOST_KEY: readFileSync(hostKeyPath, "utf8"),
      GIT_JOB_TOKEN_KEY: JOB_TOKEN_KEY,
      ...(options.sshMaxFailures ? { SSH_MAX_FAILURES: String(options.sshMaxFailures) } : {}),
    },
    r2_buckets: [{ binding: "OBJECTS", bucket_name: "infrawrench-git-test" }],
    durable_objects: { bindings: [{ name: "REPO", class_name: "RepoDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["RepoDO"] }],
    queues: {
      producers: [{ binding: "EVENTS", queue: "infrawrench-git-events-test" }],
      consumers: [
        { queue: "infrawrench-git-events-test", max_batch_size: 10, max_batch_timeout: 1 },
      ],
    },
    connect: [{ protocol: "tcp", port: sshPort }],
  };
  const configPath = join(dir, "wrangler.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const lines: string[] = [];
  const child: ChildProcess = spawn(
    join(WORKER_ROOT, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--config",
      configPath,
      "--ip",
      "127.0.0.1",
      "--port",
      String(httpPort),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      join(dir, "state"),
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WORKER_ROOT,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        // No account is needed for local development, and none must be used.
        CLOUDFLARE_API_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`wrangler dev did not start:\n${lines.join("")}`)),
      120_000,
    );
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      lines.push(text);
      if (lines.join("").includes("Ready on")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`wrangler dev exited ${code}:\n${lines.join("")}`));
    });
  });
  await ready;

  const httpUrl = `http://127.0.0.1:${httpPort}`;
  return {
    httpUrl,
    sshPort,
    sshUrl: (path) => `ssh://git@127.0.0.1:${sshPort}/${path}`,
    sshCommand: (key) =>
      [
        "ssh",
        "-F /dev/null",
        `-i ${key.path}`,
        "-o IdentitiesOnly=yes",
        "-o IdentityAgent=none",
        "-o StrictHostKeyChecking=no",
        "-o UserKnownHostsFile=/dev/null",
        "-o LogLevel=ERROR",
      ].join(" "),
    rpc: async <T>(repoId: string, method: string, ...args: unknown[]): Promise<T> => {
      const response = await fetch(`${httpUrl}/__test/rpc`, {
        method: "POST",
        body: JSON.stringify({ repoId, method, args }),
      });
      const answer = (await response.json()) as { ok: boolean; result: T; error?: string };
      if (!answer.ok) throw new Error(answer.error);
      return answer.result;
    },
    events: async () => (await fetch(`${httpUrl}/__test/events`)).json() as never,
    memory: () => {
      let total = 0;
      for (const pid of processTree(child.pid!)) {
        const listed = spawnSync("ps", ["-o", "rss=,comm=", "-p", String(pid)], {
          encoding: "utf8",
        });
        const match = /^\s*(\d+)\s+(.*)$/.exec(listed.stdout.trim());
        if (match && match[2]!.includes("workerd")) total += Number(match[1]) * 1024;
      }
      return total;
    },
    output: () => lines.join(""),
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      // The whole group: wrangler leaves workerd behind when only it is signalled.
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // Already gone.
        }
      }, 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}
