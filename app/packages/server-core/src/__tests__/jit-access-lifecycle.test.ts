import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

/**
 * The crash-safety rules of just-in-time grants (`jit-access/lifecycle.ts`):
 * standing access is checked exactly once and never revoked, a retried grant
 * never mistakes its own earlier work for standing access, a failed revoke is
 * a stored, alerted state rather than a thrown error, a revoke the provider
 * still reports afterwards is a failure, and a row somebody else holds is
 * never touched.
 *
 * Real Drizzle over the recording driver; each query's rows are queued FIFO
 * in execution order and decode positionally, so `row()` keeps the
 * `jit_access_requests` column order.
 */
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const client = {
  checkJitAccess: vi.fn(async (): Promise<"present" | "absent" | "unknown"> => "absent"),
  grantJitAccess: vi.fn(async () => ({ ref: "binding-1" })),
  revokeJitAccess: vi.fn(async () => undefined),
};
vi.mock("../org-accounts", () => ({
  getOrgAccountClient: vi.fn(async () => ({
    client,
    plugin: { manifest: { jitAccess: { scopeLabel: "Project" } } },
    account: { id: "acct-1", pluginId: "gcp" },
  })),
}));
vi.mock("../plugin-loader", () => ({ pluginCodeAvailable: () => true }));
const routeAlert = vi.fn(async () => ({ slackMessages: [] }));
vi.mock("../alerts/route", () => ({ routeAlert: (...a: unknown[]) => routeAlert(...(a as [])) }));
vi.mock("../app-url", () => ({ appPath: (p: string) => `https://app.test${p}` }));

let lifecycle: typeof import("../jit-access/lifecycle");

const updates = () => pg.queries.filter((q) => q.sql.startsWith("update"));
const audits = () =>
  pg.queries.filter((q) => q.sql.startsWith("insert") && q.sql.includes("audit_logs"));

/** A stored request; keys in `jit_access_requests` column order. */
function row(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "11111111-2222-3333-4444-555555555555",
    organizationId: "org1",
    policyId: "pol-1",
    policyName: "Prod",
    accountId: "acct-1",
    accountName: "GCP prod",
    pluginId: "gcp",
    scopeId: "proj",
    scopeName: "proj",
    roleId: "roles/storage.admin",
    roleName: "Storage Admin",
    userId: "dana",
    userName: "Dana",
    userEmail: "dana@example.com",
    principalId: "user:dana@example.com",
    principalName: "Dana",
    principalKind: "user",
    principalMatched: true,
    reason: "Restore the bucket from yesterday, INC-42",
    ticket: null,
    durationMinutes: 60,
    status: "granting",
    requestExpiresAt: new Date(now + 30 * 60_000),
    decidedAt: new Date(now),
    decidedByUserId: "sam",
    decidedByName: "Sam",
    decisionNote: null,
    selfApproved: false,
    incidentId: null,
    grantedAt: null,
    grantExpiresAt: null,
    grantRef: null,
    preexisting: false,
    extendedMinutes: 0,
    endedAt: null,
    endedByUserId: null,
    endedByName: null,
    endReason: null,
    lastError: null,
    grantAttempts: 0,
    revokeAttempts: 0,
    nextActionAt: new Date(now + 5 * 60_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ...overrides,
  };
}

type Row = Parameters<typeof import("../jit-access/lifecycle").executeGrant>[0];
const asRow = (r: ReturnType<typeof row>) => r as unknown as Row;

beforeEach(async () => {
  vi.clearAllMocks();
  client.checkJitAccess.mockResolvedValue("absent");
  client.grantJitAccess.mockResolvedValue({ ref: "binding-1" });
  client.revokeJitAccess.mockResolvedValue(undefined);
  pg.reset();
  lifecycle = await import("../jit-access/lifecycle");
});

describe("executeGrant", () => {
  it("records standing access as preexisting and grants nothing", async () => {
    client.checkJitAccess.mockResolvedValue("present");
    pg.queueRows([row({ status: "active", preexisting: true, grantedAt: new Date() })]);
    pg.queueRows([]); // audit
    const after = await lifecycle.executeGrant(asRow(row()));
    expect(after.status).toBe("active");
    expect(after.preexisting).toBe(true);
    expect(client.grantJitAccess).not.toHaveBeenCalled();
    expect(updates()[0]!.sql).toContain('"preexisting"');
  });

  it("checks once, records the window, then grants", async () => {
    const expires = new Date(Date.now() + 60 * 60_000);
    pg.queueRows([row({ grantedAt: new Date(), grantExpiresAt: expires })]); // stage 1
    pg.queueRows([row({ status: "active", grantedAt: new Date(), grantExpiresAt: expires })]);
    pg.queueRows([]); // audit
    const after = await lifecycle.executeGrant(asRow(row()));
    expect(client.checkJitAccess).toHaveBeenCalledTimes(1);
    expect(client.grantJitAccess).toHaveBeenCalledTimes(1);
    expect(after.status).toBe("active");
    // Every transition is conditional on the status it expects.
    for (const u of updates()) expect(u.sql).toContain('"status" =');
  });

  it("never re-runs the standing-access check on a retry", async () => {
    // The first attempt got as far as recording the window; its grant may or
    // may not have landed. A check now would see our own grant as standing
    // access and the request would never be revoked.
    const expires = new Date(Date.now() + 60 * 60_000);
    pg.queueRows([row({ status: "active", grantedAt: new Date(), grantExpiresAt: expires })]);
    pg.queueRows([]);
    await lifecycle.executeGrant(
      asRow(row({ grantedAt: new Date(), grantExpiresAt: expires, grantAttempts: 1 })),
    );
    expect(client.checkJitAccess).not.toHaveBeenCalled();
    expect(client.grantJitAccess).toHaveBeenCalledTimes(1);
  });

  it("revokes instead of granting once the window has passed", async () => {
    const past = new Date(Date.now() - 60_000);
    pg.queueRows([row({ status: "revoking", grantedAt: past, grantExpiresAt: past })]); // claim
    pg.queueRows([row({ status: "revoked", grantedAt: past, grantExpiresAt: past })]); // done
    pg.queueRows([]); // audit
    const after = await lifecycle.executeGrant(
      asRow(row({ grantedAt: past, grantExpiresAt: past, grantAttempts: 1 })),
    );
    expect(client.grantJitAccess).not.toHaveBeenCalled();
    expect(client.revokeJitAccess).toHaveBeenCalledTimes(1);
    expect(after.status).toBe("revoked");
  });
});

describe("executeRevoke", () => {
  const active = () =>
    row({
      status: "active",
      grantedAt: new Date(Date.now() - 3_600_000),
      grantExpiresAt: new Date(Date.now() - 1000),
    });

  it("does nothing when another worker holds the row", async () => {
    pg.queueRows([]); // claim matched nothing
    const after = await lifecycle.executeRevoke(asRow(active()), "expired", lifecycle.SWEEP_ACTOR);
    expect(client.revokeJitAccess).not.toHaveBeenCalled();
    expect(after.status).toBe("active");
  });

  it("never calls the provider for preexisting access", async () => {
    pg.queueRows([{ ...active(), status: "revoking", preexisting: true }]);
    pg.queueRows([{ ...active(), status: "revoked", preexisting: true }]);
    pg.queueRows([]);
    const after = await lifecycle.executeRevoke(
      asRow({ ...active(), preexisting: true }),
      "expired",
      lifecycle.SWEEP_ACTOR,
    );
    expect(client.revokeJitAccess).not.toHaveBeenCalled();
    expect(after.status).toBe("revoked");
  });

  it("stores a failed revoke, audits it and alerts", async () => {
    client.revokeJitAccess.mockRejectedValue(new Error("403 PERMISSION_DENIED"));
    pg.queueRows([{ ...active(), status: "revoking" }]);
    pg.queueRows([{ ...active(), status: "revoke_failed", revokeAttempts: 1 }]);
    pg.queueRows([]); // audit
    const after = await lifecycle.executeRevoke(asRow(active()), "expired", lifecycle.SWEEP_ACTOR);
    expect(after.status).toBe("revoke_failed");
    expect(audits().length).toBe(1);
    expect(JSON.stringify(audits()[0]!.params)).toContain("jit_access.revoke_failed");
    expect(routeAlert).toHaveBeenCalledTimes(1);
  });

  it("treats a grant still present after revoking as a failure", async () => {
    client.checkJitAccess.mockResolvedValue("present");
    pg.queueRows([{ ...active(), status: "revoking" }]);
    pg.queueRows([{ ...active(), status: "revoke_failed", revokeAttempts: 1 }]);
    pg.queueRows([]);
    const after = await lifecycle.executeRevoke(asRow(active()), "expired", lifecycle.SWEEP_ACTOR);
    expect(client.revokeJitAccess).toHaveBeenCalledTimes(1);
    expect(after.status).toBe("revoke_failed");
  });
});
