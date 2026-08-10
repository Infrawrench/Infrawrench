import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const CAPTURE_MAX_BYTES = 256 * 1024;

const sshClients: FakeSshClient[] = [];

class FakeSshClient extends EventEmitter {
  ended = false;
  execCb: ((err: Error | undefined, stream: FakeExecStream) => void) | null = null;

  constructor() {
    super();
    sshClients.push(this);
  }

  connect(_cfg: Record<string, unknown>) {}

  exec(_cmd: string, cb: (err: Error | undefined, stream: FakeExecStream) => void) {
    this.execCb = cb;
  }

  end() {
    this.ended = true;
  }
}

class FakeExecStream extends EventEmitter {
  stderr = new EventEmitter();
}

// The source default-imports ssh2 (CJS interop), so mirror the module there.
vi.mock("ssh2", () => {
  const mod = { Client: FakeSshClient };
  return { ...mod, default: mod };
});

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/services/encryption", () => ({
  decrypt: vi.fn().mockResolvedValue("PRIVATE_KEY"),
  buildAad: vi.fn().mockReturnValue("aad"),
}));
vi.mock("@/services/ssh-host-keys", () => ({
  HostKeyTrustRequiredError: class extends Error {},
  makeHostKeyVerifier: vi.fn().mockReturnValue(() => true),
}));

const { sshExecCapture } = await import("@/services/ssh");

const CONFIG = { host: "203.0.113.5", port: 22, username: "root", privateKey: "KEY" };

/** Start a capture and hand back the fake stream once exec is in flight. */
function startCapture() {
  const promise = sshExecCapture("org-1", CONFIG, "uname -r");
  const client = sshClients.at(-1)!;
  client.emit("ready");
  const stream = new FakeExecStream();
  client.execCb!(undefined, stream);
  return { promise, client, stream };
}

beforeEach(() => {
  sshClients.length = 0;
});

describe("sshExecCapture", () => {
  it("resolves stdout, stderr, and the numeric exit code", async () => {
    const { promise, client, stream } = startCapture();
    stream.emit("data", Buffer.from("kernel 6.8\n"));
    stream.stderr.emit("data", Buffer.from("warning\n"));
    stream.emit("close", 3);
    await expect(promise).resolves.toEqual({
      stdout: "kernel 6.8\n",
      stderr: "warning\n",
      exitCode: 3,
    });
    expect(client.ended).toBe(true);
  });

  it("caps each stream at CAPTURE_MAX_BYTES even for a single oversized chunk", async () => {
    const { promise, stream } = startCapture();
    stream.emit("data", Buffer.alloc(300 * 1024, "a"));
    stream.stderr.emit("data", Buffer.alloc(300 * 1024, "e"));
    stream.emit("close", 0);
    const result = await promise;
    expect(Buffer.byteLength(result.stdout)).toBe(CAPTURE_MAX_BYTES);
    expect(Buffer.byteLength(result.stderr)).toBe(CAPTURE_MAX_BYTES);
  });

  it("counts bytes, not characters, and never splits a multi-byte character at the cap", async () => {
    const { promise, stream } = startCapture();
    // Fill to one byte under the cap, then send a 2-byte character: only its
    // first byte fits, and the clipped tail must be dropped — not decoded into
    // a replacement character that would push the string back over budget.
    stream.emit("data", Buffer.alloc(CAPTURE_MAX_BYTES - 1, "a"));
    stream.emit("data", Buffer.from("é"));
    stream.emit("close", 0);
    const result = await promise;
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(CAPTURE_MAX_BYTES);
    expect(result.stdout).not.toContain("�");
    expect(result.stdout).toBe("a".repeat(CAPTURE_MAX_BYTES - 1));
  });

  it("keeps the per-stream limit across many multi-byte chunks", async () => {
    const { promise, stream } = startCapture();
    // 3-byte characters, 96 KiB per chunk, four chunks = 384 KiB offered.
    const chunk = Buffer.from("€".repeat(32 * 1024));
    for (let i = 0; i < 4; i++) stream.emit("data", chunk);
    stream.emit("close", 0);
    const result = await promise;
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(CAPTURE_MAX_BYTES);
    expect(result.stdout).not.toContain("�");
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const { promise, stream } = startCapture();
    const bytes = Buffer.from("é");
    stream.emit("data", bytes.subarray(0, 1));
    stream.emit("data", bytes.subarray(1));
    stream.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ stdout: "é" });
  });

  it("rejects when the command is terminated by a signal instead of exiting 0", async () => {
    const { promise, stream } = startCapture();
    stream.emit("data", Buffer.from("partial"));
    stream.emit("close", null, "SIGTERM");
    await expect(promise).rejects.toThrow(/terminated by SIGTERM/);
  });

  it("rejects when the channel closes without any exit status", async () => {
    const { promise, stream } = startCapture();
    stream.emit("close");
    await expect(promise).rejects.toThrow(/without an exit status/);
  });
});
