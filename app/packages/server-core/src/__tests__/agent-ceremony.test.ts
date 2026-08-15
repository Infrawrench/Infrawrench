import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Registration, credential issuance and the claim ceremony.
 *
 * The properties worth pinning here are all security properties: the
 * credential and the user code are never stored recoverably, the rate limit is
 * checked before anything is created, and a revoked registration stops
 * authenticating immediately rather than when its token would have expired.
 */

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

vi.mock("../permissions/resolver", () => ({
  ensureSystemRoles: vi.fn(async () => undefined),
  getSystemRole: vi.fn(async () => ({ id: "role-owner" })),
}));

// A stable, reversible stand-in so a test can assert "the stored value is not
// the secret" without reimplementing HMAC.
vi.mock("../encryption", () => ({
  keyedHash: vi.fn(async (data: string, domain: string) => `hash(${domain}:${data})`),
}));

let ceremony: typeof import("../trials/ceremony");

const inserts = (table: string) =>
  pg.queries.filter((q) => q.sql.startsWith(`insert into "${table}"`));
const updates = (table: string) => pg.queries.filter((q) => q.sql.startsWith(`update "${table}"`));

beforeEach(async () => {
  pg.reset();
  vi.resetModules();
  ceremony = await import("../trials/ceremony");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerAnonymousAgent", () => {
  /** Rate-limit probes: global count, then per-IP count. */
  function allowRegistration() {
    pg.queueRows([{ n: 0 }]);
    pg.queueRows([{ n: 0 }]);
  }

  it("issues an iwa_ credential and stores only its hash", async () => {
    allowRegistration();
    const result = await ceremony.registerAnonymousAgent({ ip: "1.2.3.4" });

    expect(result.credential.startsWith("iwa_")).toBe(true);

    const [update] = updates("agent_auth_registrations");
    // The plaintext must not appear in any statement we issued.
    for (const q of pg.queries) {
      expect(q.params).not.toContain(result.credential);
    }
    expect(update?.params).toContain(`hash(agent-credential:${result.credential})`);
  });

  it("stores the credential prefix for display", async () => {
    allowRegistration();
    const result = await ceremony.registerAnonymousAgent({ ip: "1.2.3.4" });
    const [update] = updates("agent_auth_registrations");
    expect(update?.params).toContain(result.credential.slice(0, 8));
  });

  it("refuses past the per-IP hourly limit, before creating anything", async () => {
    pg.queueRows([{ n: 0 }]); // global is fine
    pg.queueRows([{ n: ceremony.REGISTRATIONS_PER_IP_PER_HOUR }]); // this IP is not

    await expect(ceremony.registerAnonymousAgent({ ip: "1.2.3.4" })).rejects.toThrow(
      /per hour from one address/,
    );
    // The limit exists to stop organizations being created, so checking after
    // creating one would be a limit on nothing.
    expect(inserts("organizations")).toHaveLength(0);
  });

  it("refuses past the global hourly ceiling whatever the address", async () => {
    pg.queueRows([{ n: ceremony.GLOBAL_REGISTRATIONS_PER_HOUR }]);
    await expect(ceremony.registerAnonymousAgent({ ip: "1.2.3.4" })).rejects.toThrow(
      /temporarily paused/,
    );
    expect(inserts("organizations")).toHaveLength(0);
  });

  it("still applies the global ceiling when there is no source address", async () => {
    pg.queueRows([{ n: ceremony.GLOBAL_REGISTRATIONS_PER_HOUR }]);
    await expect(ceremony.registerAnonymousAgent({})).rejects.toThrow(/temporarily paused/);
  });
});

describe("claim codes", () => {
  it("normalises formatting and case", () => {
    const code = "K7MP2Q9X";
    expect(ceremony.normalizeClaimCode("k7mp-2q9x")).toBe(code);
    expect(ceremony.normalizeClaimCode(" K7MP 2Q9X ")).toBe(code);
    expect(ceremony.formatClaimCode(code)).toBe("K7MP-2Q9X");
  });

  it("rejects anything that cannot be a code", () => {
    expect(ceremony.normalizeClaimCode("123")).toBeNull();
    expect(ceremony.normalizeClaimCode("K7MP2Q9XY")).toBeNull();
    // I, L, O and U are not in the alphabet — a code containing one was
    // mistyped from a character that is.
    expect(ceremony.normalizeClaimCode("IIIIIIII")).toBeNull();
  });

  it("mints a code of the expected shape and stores only its hash", async () => {
    pg.queueRows([{ claimedAt: null, revokedAt: null }]);
    const started = await ceremony.startClaimCeremony("reg_1");

    expect(ceremony.normalizeClaimCode(started.userCode)).toBe(started.userCode);
    const [update] = updates("agent_auth_registrations");
    expect(update?.params).not.toContain(started.userCode);
    expect(update?.params).toContain(`hash(agent-claim-code:${started.userCode})`);
  });

  it("refuses to start a ceremony for an already-claimed registration", async () => {
    pg.queueRows([{ claimedAt: new Date(), revokedAt: null }]);
    await expect(ceremony.startClaimCeremony("reg_1")).rejects.toThrow(/already claimed/);
  });

  it("refuses to start a ceremony for a revoked registration", async () => {
    pg.queueRows([{ claimedAt: null, revokedAt: new Date() }]);
    await expect(ceremony.startClaimCeremony("reg_1")).rejects.toThrow(/revoked/);
  });

  it("rejects an expired code", async () => {
    pg.queueRows([{ id: "reg_1", claimCodeExpiresAt: new Date(Date.now() - 1000) }]);
    await expect(ceremony.resolveClaimCode("K7MP2Q9X")).rejects.toThrow(/expired/);
  });

  it("rejects a code that matches nothing", async () => {
    pg.queueRows([]);
    await expect(ceremony.resolveClaimCode("K7MP2Q9X")).rejects.toThrow(/not valid/);
  });

  it("resolves a live code to its registration", async () => {
    pg.queueRows([{ id: "reg_1", claimCodeExpiresAt: new Date(Date.now() + 60_000) }]);
    expect(await ceremony.resolveClaimCode("k7mp-2q9x")).toBe("reg_1");
  });

  it("only ever considers unclaimed, unrevoked registrations", async () => {
    pg.queueRows([{ id: "reg_1", claimCodeExpiresAt: new Date(Date.now() + 60_000) }]);
    await ceremony.resolveClaimCode("K7MP2Q9X");
    const select = pg.queries.find((q) => q.sql.startsWith("select"));
    expect(select?.sql).toContain('"claimed_at" is null');
    expect(select?.sql).toContain('"revoked_at" is null');
  });
});

describe("resolveAgentCredential", () => {
  it("ignores a token that is not ours", async () => {
    expect(await ceremony.resolveAgentCredential("iwk_something")).toBeNull();
    expect(pg.queries).toHaveLength(0);
  });

  it("refuses a revoked registration", async () => {
    pg.queueRows([]);
    expect(await ceremony.resolveAgentCredential("iwa_abc")).toBeNull();
    const select = pg.queries.find((q) => q.sql.startsWith("select"));
    // Revocation has to be checked here, because the credential itself stays
    // syntactically valid forever — this query is what ends the access.
    expect(select?.sql).toContain('"revoked_at" is null');
  });

  it("resolves a live credential to its registration id", async () => {
    pg.queueRows([{ id: "reg_1" }]);
    expect(await ceremony.resolveAgentCredential("iwa_abc")).toBe("reg_1");
  });
});

describe("revokeAgentRegistration", () => {
  it("clears any in-flight claim code as it revokes", async () => {
    pg.setRows([{ id: "reg_1" }]);
    await ceremony.revokeAgentRegistration("reg_1");
    const [update] = updates("agent_auth_registrations");
    // Otherwise a code handed out moments before revocation would still bind a
    // person to a registration that was just cut off.
    expect(update?.sql).toContain('"hashed_claim_code"');
    expect(update?.sql).toContain('"revoked_at"');
  });

  it("reports false when the row was already revoked", async () => {
    pg.setRows([]);
    expect(await ceremony.revokeAgentRegistration("reg_1")).toBe(false);
  });
});
