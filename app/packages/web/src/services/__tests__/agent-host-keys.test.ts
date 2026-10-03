import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Fingerprint } from "@infrawrench/ssh-tunnel-core";

// One agent_sessions row behind a Drizzle-style chain mock.
const session: { createdAt: Date; hostKeyFingerprint: string | null } = {
  createdAt: new Date(),
  hostKeyFingerprint: null,
};
let sessionExists = true;

vi.mock("../../db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(sessionExists ? [{ ...session }] : []),
        }),
      }),
    }),
    update: () => ({
      set: (values: { hostKeyFingerprint: string }) => ({
        where: () => ({
          returning: () => {
            if (session.hostKeyFingerprint) return Promise.resolve([]);
            session.hostKeyFingerprint = values.hostKeyFingerprint;
            return Promise.resolve([{ id: "s1" }]);
          },
        }),
      }),
    }),
  },
}));

const orgPins = new Map<string, string>();
vi.mock("../ssh-host-keys", () => ({
  lookupHostKeyPin: async (_org: string, host: string, port: number) =>
    orgPins.get(`${host}:${port}`) ?? null,
  trustHostKey: async (_org: string, host: string, port: number, fp: string) => {
    orgPins.set(`${host}:${port}`, fp);
  },
}));

const { verifyAgentHostKey } = await import("../agent-host-keys");

const keyA = Buffer.from("host-key-a");
const keyB = Buffer.from("host-key-b");
const verify = (key: Buffer, host = "203.0.113.5") =>
  verifyAgentHostKey("s1", "org-1", host, 22, key);

beforeEach(() => {
  session.createdAt = new Date();
  session.hostKeyFingerprint = null;
  sessionExists = true;
  orgPins.clear();
});

describe("cloud agent VM host-key pinning", () => {
  it("pins the first key of a fresh session and refuses a different one after", async () => {
    await verify(keyA);
    expect(session.hostKeyFingerprint).toBe(sha256Fingerprint(keyA));
    expect(orgPins.get("203.0.113.5:22")).toBe(sha256Fingerprint(keyA));
    await expect(verify(keyB)).rejects.toThrow(/different SSH host key/);
    expect(session.hostKeyFingerprint).toBe(sha256Fingerprint(keyA));
  });

  it("refuses an old session's unpinned key the org does not already trust", async () => {
    session.createdAt = new Date(Date.now() - 48 * 3600_000);
    await expect(verify(keyA)).rejects.toThrow(/no pinned SSH host key/);
    expect(session.hostKeyFingerprint).toBeNull();
  });

  it("adopts an old session's key the org already trusts", async () => {
    session.createdAt = new Date(Date.now() - 48 * 3600_000);
    orgPins.set("203.0.113.5:22", sha256Fingerprint(keyA));
    await verify(keyA);
    expect(session.hostKeyFingerprint).toBe(sha256Fingerprint(keyA));
  });

  it("refuses a session that does not exist in the organization", async () => {
    sessionExists = false;
    await expect(verify(keyA)).rejects.toThrow(/not found/);
  });
});
