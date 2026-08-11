/**
 * The ambient audit principal, and the one thing about it that is easy to get
 * wrong: `enterWith` reaches the *current* execution's descendants, not the
 * caller of an awaited function. `authenticateOrgRequest` used to try to
 * establish the principal from inside itself, which silently did nothing —
 * these tests pin why the call now lives in the handler instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted: Array<Record<string, unknown>> = [];
vi.mock("@/db/client", () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve(undefined);
      },
    }),
  },
}));
vi.mock("@/db/schema", () => ({ auditLogs: { id: "id" } }));

const { runWithAuditPrincipal, enterAuditPrincipal, currentAuditPrincipal } =
  await import("@/services/audit-context");
const { logAudit } = await import("@/services/audit");

const PRINCIPAL = { apiKeyId: "key-1", userId: "u1" };

beforeEach(() => {
  inserted.length = 0;
});

describe("runWithAuditPrincipal", () => {
  it("is visible to the callback and to anything it awaits", async () => {
    expect(currentAuditPrincipal()).toBeUndefined();
    await runWithAuditPrincipal(PRINCIPAL, async () => {
      expect(currentAuditPrincipal()).toEqual(PRINCIPAL);
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(currentAuditPrincipal()).toEqual(PRINCIPAL);
    });
  });

  it("does not leak out of the callback", async () => {
    await runWithAuditPrincipal(PRINCIPAL, async () => Promise.resolve());
    expect(currentAuditPrincipal()).toBeUndefined();
  });

  /**
   * Fire-and-forget is the house style for `logAudit`. The store is captured
   * when the promise starts, so an un-awaited call still records the key.
   */
  it("covers a fire-and-forget logAudit", async () => {
    // `logAudit` resolves to whether the row landed; fire-and-forget callers
    // ignore it, and this one only cares that the principal was captured.
    let pending: Promise<boolean> | undefined;
    await runWithAuditPrincipal(PRINCIPAL, async () => {
      pending = logAudit({
        organizationId: "org-1",
        userId: "u1",
        action: "thing.done",
        entityType: "thing",
        entityId: "t1",
      });
    });
    await pending;
    expect(inserted[0]).toMatchObject({ apiKeyId: "key-1" });
  });
});

describe("enterAuditPrincipal", () => {
  it("reaches the rest of the current execution", async () => {
    async function handler() {
      enterAuditPrincipal(PRINCIPAL);
      await Promise.resolve();
      return currentAuditPrincipal();
    }
    expect(await handler()).toEqual(PRINCIPAL);
  });

  /**
   * The reason `authenticateOrgRequest` returns `apiKeyId` for its callers to
   * enter, rather than entering it itself.
   */
  it("does not reach the caller of an awaited function", async () => {
    async function authenticate() {
      await Promise.resolve();
      enterAuditPrincipal(PRINCIPAL);
    }
    async function handler() {
      await authenticate();
      return currentAuditPrincipal();
    }
    expect(await handler()).toBeUndefined();
  });
});

describe("logAudit", () => {
  it("records no key when there is no ambient principal", async () => {
    await logAudit({
      organizationId: "org-1",
      userId: "u1",
      action: "thing.done",
      entityType: "thing",
      entityId: "t1",
    });
    expect(inserted[0]).toMatchObject({ apiKeyId: null });
  });

  it("prefers an explicitly passed key over the ambient one", async () => {
    await runWithAuditPrincipal(PRINCIPAL, () =>
      logAudit({
        organizationId: "org-1",
        userId: "u1",
        apiKeyId: "explicit-key",
        action: "thing.done",
        entityType: "thing",
        entityId: "t1",
      }),
    );
    expect(inserted[0]).toMatchObject({ apiKeyId: "explicit-key" });
  });
});
