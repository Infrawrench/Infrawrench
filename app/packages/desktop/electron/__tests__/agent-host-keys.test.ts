import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Fingerprint } from "@infrawrench/ssh-tunnel-core";

import { parseSqliteUtc, verifyAgentHostKey } from "../agent-host-keys";

// One in-memory agent_sessions row; the module only ever reads the pin and
// conditionally fills it.
const { session, hostPins, prompt } = vi.hoisted(() => ({
  session: { id: "s1", created_at: "", host_key_fingerprint: null as string | null },
  hostPins: new Map<string, string>(),
  prompt: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../main-utils", () => ({
  getDb: async () => ({
    select: async (_sql: string, params: unknown[]) => (params[0] === session.id ? [session] : []),
    execute: async (_sql: string, params: unknown[]) => {
      if (params[1] === session.id && !session.host_key_fingerprint) {
        session.host_key_fingerprint = params[0] as string;
      }
      return { rowsAffected: 1, lastInsertId: 0 };
    },
  }),
}));
vi.mock("../ssh-host-key-prompt", () => ({ promptHostKeyDecision: () => prompt() }));
vi.mock("../ssh-host-keys", () => ({
  HostKeyMismatchError: class extends Error {},
  lookupHostKeyPin: async (host: string, port: number) => hostPins.get(`${host}:${port}`),
  pinHostKey: async (host: string, port: number, fp: string) => {
    hostPins.set(`${host}:${port}`, fp);
  },
}));

const keyA = Buffer.from("host-key-a");
const keyB = Buffer.from("host-key-b");

function sqliteNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
}

beforeEach(() => {
  session.created_at = sqliteNow();
  session.host_key_fingerprint = null;
  hostPins.clear();
  prompt.mockReset();
});

describe("agent VM host-key pinning", () => {
  it("parses sql.js datetime('now') as UTC", () => {
    expect(parseSqliteUtc("2026-10-03 12:00:00").toISOString()).toBe("2026-10-03T12:00:00.000Z");
  });

  it("trusts the first key of a fresh session without prompting, then enforces it", async () => {
    expect(await verifyAgentHostKey("s1", "203.0.113.5", 22, keyA)).toEqual({ ok: true });
    expect(session.host_key_fingerprint).toBe(sha256Fingerprint(keyA));
    expect(hostPins.get("203.0.113.5:22")).toBe(sha256Fingerprint(keyA));
    expect(prompt).not.toHaveBeenCalled();

    const swapped = await verifyAgentHostKey("s1", "203.0.113.5", 22, keyB);
    expect(swapped.ok).toBe(false);
    // Fails closed: no "accept anyway" prompt, and the pin is untouched.
    expect(prompt).not.toHaveBeenCalled();
    expect(session.host_key_fingerprint).toBe(sha256Fingerprint(keyA));
  });

  it("keeps the pin when the VM moves to a new address", async () => {
    session.host_key_fingerprint = sha256Fingerprint(keyA);
    session.created_at = sqliteNow(-48 * 3600_000);
    expect(await verifyAgentHostKey("s1", "198.51.100.7", 22, keyA)).toEqual({ ok: true });
    expect((await verifyAgentHostKey("s1", "198.51.100.7", 22, keyB)).ok).toBe(false);
  });

  it("asks before trusting an old session that was never pinned", async () => {
    session.created_at = sqliteNow(-48 * 3600_000);
    prompt.mockResolvedValueOnce(false);
    expect((await verifyAgentHostKey("s1", "203.0.113.5", 22, keyA)).ok).toBe(false);
    expect(session.host_key_fingerprint).toBeNull();

    prompt.mockResolvedValueOnce(true);
    expect(await verifyAgentHostKey("s1", "203.0.113.5", 22, keyA)).toEqual({ ok: true });
    expect(session.host_key_fingerprint).toBe(sha256Fingerprint(keyA));
  });

  it("adopts an old session's key silently when the user already trusts it", async () => {
    session.created_at = sqliteNow(-48 * 3600_000);
    hostPins.set("203.0.113.5:22", sha256Fingerprint(keyA));
    expect(await verifyAgentHostKey("s1", "203.0.113.5", 22, keyA)).toEqual({ ok: true });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("refuses an unknown session", async () => {
    expect((await verifyAgentHostKey("nope", "203.0.113.5", 22, keyA)).ok).toBe(false);
  });
});

describe("SSH IPC surface", () => {
  // Source text, not imports: these modules pull in `electron`.
  const ELECTRON_DIR = join(process.cwd(), "electron");

  it("gives the renderer no way to skip host-key verification", () => {
    for (const file of ["ssh-host.ts", "ssh-tunnel.ts", "sftp.ts", "agent-setup.ts"]) {
      const source = readFileSync(join(ELECTRON_DIR, file), "utf8");
      expect(source, file).not.toMatch(/skipHostKeyCheck/);
      expect(source, file).not.toMatch(/verify\(true\)\s*[,)]/);
    }
  });
});
