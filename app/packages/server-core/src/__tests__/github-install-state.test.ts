import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  INSTALL_STATE_TTL_MS,
  signInstallState,
  userCanAccessInstallation,
  verifyInstallState,
} from "../github/app";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

beforeAll(() => {
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", PEM);
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const NOW = 1_800_000_000_000;

/** Sign an arbitrary payload with the real key, the way an old server would have. */
function signRaw(payload: string): string {
  const key = createHash("sha256").update(PEM).digest();
  const mac = createHmac("sha256", key).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

describe("GitHub install state", () => {
  it("round-trips the org, user, return page and installation", () => {
    const state = signInstallState(
      { organizationId: "org1", userId: "user1", returnTo: "workflows", installationId: 42 },
      NOW,
    );
    expect(verifyInstallState(state, NOW + 1000)).toEqual({
      organizationId: "org1",
      userId: "user1",
      returnTo: "workflows",
      installationId: 42,
    });
  });

  it("is unique per call, even for the same inputs", () => {
    const a = signInstallState({ organizationId: "org1", userId: "user1" }, NOW);
    const b = signInstallState({ organizationId: "org1", userId: "user1" }, NOW);
    expect(a).not.toBe(b);
  });

  it("expires", () => {
    const state = signInstallState({ organizationId: "org1", userId: "user1" }, NOW);
    expect(verifyInstallState(state, NOW + INSTALL_STATE_TTL_MS - 1)).not.toBeNull();
    expect(verifyInstallState(state, NOW + INSTALL_STATE_TTL_MS)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const state = signInstallState({ organizationId: "org1", userId: "user1" }, NOW);
    const [, mac] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({ o: "victim", u: "user1", n: "x", e: NOW + 10_000 }),
    ).toString("base64url");
    expect(verifyInstallState(`${forged}.${mac}`, NOW)).toBeNull();
  });

  it("rejects a truncated or malformed mac", () => {
    const state = signInstallState({ organizationId: "org1", userId: "user1" }, NOW);
    expect(verifyInstallState(state.slice(0, -4), NOW)).toBeNull();
    expect(verifyInstallState(`${state}.extra`, NOW)).toBeNull();
    expect(verifyInstallState("", NOW)).toBeNull();
  });

  it("refuses states minted before user binding and expiry existed", () => {
    // The old shapes: `{o, r}` JSON, and a bare org id. Both are validly signed.
    expect(verifyInstallState(signRaw(JSON.stringify({ o: "org1", r: "agents" })), NOW)).toBeNull();
    expect(verifyInstallState(signRaw("org1"), NOW)).toBeNull();
  });
});

describe("userCanAccessInstallation", () => {
  it("finds the installation among the user's installations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ total_count: 2, installations: [{ id: 1 }, { id: 42 }] })),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(userCanAccessInstallation("ghu_x", 42)).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/user/installations");
  });

  it("answers false when the user cannot see it", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ total_count: 1, installations: [{ id: 1 }] })),
        ),
    );
    await expect(userCanAccessInstallation("ghu_x", 42)).resolves.toBe(false);
  });
});
