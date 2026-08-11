import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

/**
 * The revert apply path, from the route down.
 *
 * Two properties are worth a route-level test rather than a unit test, because
 * both are about *what happens between* the calls the unit tests cover:
 *
 * 1. **Nothing sits between the live read and the provider write.** The plan is
 *    rebuilt against a fresh `getResource` precisely so a field that moved since
 *    the preview drops out; every millisecond between that read and the
 *    `updateResource` that follows is a window in which a third party's write is
 *    silently overwritten. The window can't be closed — `updateResource` takes
 *    no precondition — so the least the handler can do is not *widen* it, and
 *    rebuilding the plugin client (credential decrypt, credential rewriters,
 *    host services) between the two is exactly that.
 * 2. **The event is only marked reverted once the provider accepted the write.**
 *    Claiming and completing are different columns; the failure paths must leave
 *    the event retryable.
 */

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const dbMock = {
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    insert: vi.fn(),
    delete: vi.fn(),
  },
};
vi.mock("@/db/client", () => dbMock);
vi.mock("@infrawrench/server-core/db/client", () => dbMock);

const mockGetClientForAccount = vi.fn();
vi.mock("@/services/plugin-clients", () => ({
  getClientForAccount: (...args: unknown[]) => mockGetClientForAccount(...args),
}));

vi.mock("@/services/change-freezes", () => ({
  checkChangeFreeze: vi.fn().mockResolvedValue(null),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));
vi.mock("@infrawrench/server-core/drift/settings", () => ({
  getDriftAlertSettings: vi.fn(),
  updateDriftAlertSettings: vi.fn(),
}));

const { resourceChangeRoutes } = await import("@/api/routes/resource-changes");

const CHANGE = {
  id: "chg-1",
  organizationId: "org-1",
  accountId: "acct-1",
  resourceId: "do:acct-1:droplet/9",
  pluginId: "digitalocean",
  resourceTypeId: "droplet",
  displayName: "web-1",
  changeKind: "updated" as const,
  diff: [{ field: "size", from: "s-1vcpu-1gb", to: "s-4vcpu-8gb" }],
  createdAt: new Date("2026-08-10T09:00:00.000Z"),
  revertedAt: null as Date | null,
  revertClaimedAt: null as Date | null,
};

/** `db.select()...limit(1)` returning the one change row. */
function stubSelect(change = CHANGE) {
  mockSelect.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([change]) }) }),
  }));
}

/**
 * `db.update()...where()` / `.returning()`.
 *
 * A statement "wins" when it matches a row. Claim and completion are separable
 * because they are the only two fenced writes and they set different columns:
 * `completeWins: false` models this request's lease having lapsed and another
 * attempt having taken the event over while the provider call was in flight, so
 * the owner-fenced completion matches nothing.
 */
function stubUpdate({ claimWins = true, completeWins = true, completeThrows = false } = {}) {
  const writes: Record<string, unknown>[] = [];
  mockUpdate.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => {
      writes.push(values);
      const isCompletion = "revertedAt" in values;
      if (isCompletion && completeThrows) {
        return {
          where: () => ({
            returning: () => Promise.reject(new Error("deadlock detected")),
            then: (_fn: unknown, rej?: (e: unknown) => unknown) =>
              Promise.reject(new Error("deadlock detected")).catch((e: unknown) => {
                if (rej) return rej(e);
                throw e;
              }),
          }),
        };
      }
      const won = isCompletion ? completeWins : claimWins;
      const result = won ? [{ id: "chg-1" }] : [];
      return {
        where: () => ({
          returning: () => Promise.resolve(result),
          then: (fn: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(fn, rej),
        }),
      };
    },
  }));
  return writes;
}

/** Did any statement release the claim (clear it without recording a revert)? */
const releasedClaim = (writes: Record<string, unknown>[]) =>
  writes.some((w) => w.revertClaimedAt === null && !("revertedAt" in w));

interface ClientOpts {
  liveSize?: string;
  updateThrows?: boolean;
}

/**
 * The plugin client, instrumented so the order of provider calls is observable.
 * `calls` records every provider interaction *and* every client construction,
 * which is what test 1 asserts on.
 */
function stubClient(opts: ClientOpts = {}) {
  const calls: string[] = [];
  const updateResource = vi.fn(async () => {
    calls.push("updateResource");
    if (opts.updateThrows) throw new Error("provider said no");
    return { id: CHANGE.resourceId, displayName: "web-1", fields: {} };
  });
  const getResource = vi.fn(async () => {
    calls.push("getResource");
    return {
      id: CHANGE.resourceId,
      pluginId: CHANGE.pluginId,
      resourceTypeId: CHANGE.resourceTypeId,
      accountId: CHANGE.accountId,
      displayName: "web-1",
      fields: { size: opts.liveSize ?? "s-4vcpu-8gb" },
      resolvedOutputs: {},
      secretStates: [],
    };
  });
  const ctx = {
    client: { getResource, updateResource },
    plugin: {
      resourceTypes: [
        {
          id: "droplet",
          supportsUpdate: true,
          fields: [
            { key: "size", label: "Size", kind: "string", required: false },
            { key: "region", label: "Region", kind: "string", required: false, editable: false },
          ],
        },
      ],
    },
    account: { id: "acct-1", pluginId: "digitalocean" },
  };
  mockGetClientForAccount.mockImplementation(async () => {
    calls.push("buildClient");
    return ctx;
  });
  return { calls, updateResource, getResource };
}

const app = () => buildTestApp(resourceChangeRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  CHANGE.revertedAt = null;
  CHANGE.revertClaimedAt = null;
});

describe("POST /:changeId/revert — the read-to-write window", () => {
  /**
   * The regression this test exists for: the handler used to call
   * `getClientForAccount` a second time after planning, so a credential
   * decrypt, the credential rewriters and a fresh host-services build all sat
   * between the `getResource` the plan was computed from and the
   * `updateResource` that acted on it.
   */
  it("writes through the same client that read, building it only once", async () => {
    stubSelect();
    stubUpdate();
    const { calls } = stubClient();

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(res.status).toBe(200);

    // One construction, and the read is immediately followed by the write.
    expect(calls).toEqual(["buildClient", "getResource", "updateResource"]);
    expect(mockGetClientForAccount).toHaveBeenCalledTimes(1);
  });

  it("applies only the fields the fresh read still agrees with", async () => {
    stubSelect();
    stubUpdate();
    const { updateResource } = stubClient();

    const res = await app().request("/chg-1/revert", { method: "POST" });
    const body = (await res.json()) as { appliedFields: string[] };
    expect(body.appliedFields).toEqual(["size"]);
    expect(updateResource).toHaveBeenCalledWith("droplet", CHANGE.resourceId, "acct-1", {
      size: "s-1vcpu-1gb",
    });
  });

  it("writes nothing when the field moved again between preview and apply", async () => {
    stubSelect();
    const writes = stubUpdate();
    const { updateResource } = stubClient({ liveSize: "s-8vcpu-16gb" });

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(res.status).toBe(409);
    expect(updateResource).not.toHaveBeenCalled();
    // Claimed, then released — never completed.
    expect(writes.some((w) => "revertedAt" in w && w.revertedAt instanceof Date)).toBe(false);
    expect(writes.at(-1)).toMatchObject({ revertClaimedAt: null });
  });
});

describe("POST /:changeId/revert — claim lifecycle", () => {
  it("marks the event reverted only after the provider accepted the write", async () => {
    stubSelect();
    const writes = stubUpdate();
    stubClient();

    await app().request("/chg-1/revert", { method: "POST" });

    // First write is the claim (a lease, not a verdict); the completion follows.
    expect(writes[0]).toMatchObject({ revertedByUserId: "user-1" });
    expect(writes[0]!.revertClaimedAt).toBeInstanceOf(Date);
    expect(writes[0]).not.toHaveProperty("revertedAt");
    expect(writes.at(-1)).toMatchObject({ revertClaimedAt: null });
    expect(writes.at(-1)!.revertedAt).toBeInstanceOf(Date);
  });

  it("releases the claim without completing when the provider write fails", async () => {
    stubSelect();
    const writes = stubUpdate();
    stubClient({ updateThrows: true });

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(res.status).toBe(400);
    expect(writes.some((w) => w.revertedAt instanceof Date)).toBe(false);
    expect(writes.at(-1)).toMatchObject({ revertClaimedAt: null, revertedByUserId: null });
  });

  it("refuses when the claim is already held", async () => {
    stubSelect();
    stubUpdate({ claimWins: false });
    const { updateResource } = stubClient();

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("change_revert_conflict");
    expect(updateResource).not.toHaveBeenCalled();
  });

  /**
   * The provider call outlived the five-minute lease and another attempt took
   * the event over. The write landed, but this request no longer owns the
   * outcome — reporting success would mean overwriting the replacement's claim,
   * and reporting a plain failure would be a lie about a write that happened.
   */
  it("reports honestly when its lease lapsed and it was superseded mid-write", async () => {
    stubSelect();
    stubUpdate({ completeWins: false });
    const { updateResource } = stubClient();

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(updateResource).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      error: string;
      appliedFields: string[];
    };
    expect(body.code).toBe("change_revert_conflict");
    expect(body.error).toMatch(/applied to the provider/);
    expect(body.error).toMatch(/took over/);
    // The fields it did write are still named, so the caller can reconcile.
    expect(body.appliedFields).toEqual(["size"]);
  });

  /**
   * A mutation that reached the provider is a mutation someone made to their
   * infrastructure, and it belongs in the audit trail whoever won the lease
   * race. Auditing after the superseded branch returned meant a successful
   * write with no actor attached to it — the one thing the audit log exists to
   * prevent.
   */
  it("audits the write even when the claim was lost, naming the actor", async () => {
    stubSelect();
    stubUpdate({ completeWins: false });
    stubClient();

    await app().request("/chg-1/revert", { method: "POST" });

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        userId: "user-1",
        action: "resource.change_revert",
        entityType: "resource",
        entityId: CHANGE.resourceId,
        metadata: expect.objectContaining({
          changeId: "chg-1",
          fieldKeys: ["size"],
          // What stops this reading as a clean revert, or as a second one.
          outcome: "superseded",
        }),
      }),
    );
  });

  it("marks the attempt that kept its claim as the recorded one", async () => {
    stubSelect();
    stubUpdate();
    stubClient();

    await app().request("/chg-1/revert", { method: "POST" });

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[0]![0]).toMatchObject({
      metadata: { outcome: "recorded", fieldKeys: ["size"] },
    });
  });

  it("audits nothing when the provider write never landed", async () => {
    stubSelect();
    stubUpdate();
    stubClient({ updateThrows: true });

    await app().request("/chg-1/revert", { method: "POST" });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("audits nothing when there was nothing to write", async () => {
    stubSelect();
    stubUpdate();
    stubClient({ liveSize: "s-1vcpu-1gb" });

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(res.status).toBe(409);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

/**
 * Rows 4, 8 and 9 of the lifecycle table on the handler: a write that lands and
 * is not recorded, and how the next attempt closes the loop. Without this the
 * feed disagrees with the provider permanently — the retry finds nothing to do
 * and walks away.
 */
describe("POST /:changeId/revert — a write that landed but was never recorded", () => {
  it("keeps the claim when the completion write fails, and says the resource moved", async () => {
    stubSelect();
    const writes = stubUpdate({ completeThrows: true });
    const { updateResource } = stubClient();

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(updateResource).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; appliedFields: string[] };
    expect(body.error).toMatch(/applied to the provider/);
    expect(body.appliedFields).toEqual(["size"]);

    // The stale claim is the only evidence a write went unrecorded; releasing
    // it here would destroy exactly what the reconciling retry reads.
    expect(releasedClaim(writes)).toBe(false);

    // And the mutation is still attributed, database failure or not.
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[0]![0]).toMatchObject({
      userId: "user-1",
      metadata: { outcome: "unrecorded", fieldKeys: ["size"] },
    });
  });

  it("reconciles on the retry: records the revert it finds already applied", async () => {
    // The retry's view: fields already back, and a claim left behind by the
    // attempt that wrote them.
    stubSelect({ ...CHANGE, revertClaimedAt: new Date("2026-08-10T09:05:00.000Z") });
    stubUpdate();
    const { updateResource } = stubClient({ liveSize: "s-1vcpu-1gb" });

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reconciled: boolean;
      appliedFields: string[];
      revertedAt: string;
    };
    expect(body.reconciled).toBe(true);
    expect(body.appliedFields).toEqual([]);
    expect(body.revertedAt).toEqual(expect.any(String));

    // Recorded without touching the provider a second time.
    expect(updateResource).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[0]![0]).toMatchObject({
      userId: "user-1",
      metadata: { outcome: "reconciled", fieldKeys: [] },
    });
  });

  /**
   * The other side of the same coin: without a claim left behind there is no
   * evidence a revert was ever attempted, so a resource somebody put back by
   * hand must not be recorded as this user's revert.
   */
  it("does not record a hand-reverted resource as a revert", async () => {
    stubSelect({ ...CHANGE, revertClaimedAt: null });
    const writes = stubUpdate();
    const { updateResource } = stubClient({ liveSize: "s-1vcpu-1gb" });

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(res.status).toBe(409);
    expect(updateResource).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    // Claim released, event still not marked reverted.
    expect(releasedClaim(writes)).toBe(true);
    expect(writes.some((w) => w.revertedAt instanceof Date)).toBe(false);
  });

  it("still reverts normally when the stale claim's attempt never wrote", async () => {
    // Claim left behind, but the fields never moved — an attempt that died
    // before writing. Nothing to reconcile; this is an ordinary revert.
    stubSelect({ ...CHANGE, revertClaimedAt: new Date("2026-08-10T09:05:00.000Z") });
    stubUpdate();
    const { updateResource } = stubClient({ liveSize: "s-4vcpu-8gb" });

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(res.status).toBe(200);
    expect(updateResource).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[0]![0]).toMatchObject({
      metadata: { outcome: "recorded" },
    });
  });

  it("refuses an event that already completed, without touching the provider", async () => {
    stubSelect({ ...CHANGE, revertedAt: new Date("2026-08-10T10:00:00.000Z") });
    stubUpdate();
    const { calls } = stubClient();

    const res = await app().request("/chg-1/revert", { method: "POST" });
    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });
});

describe("GET /:changeId/revert — dry run", () => {
  it("reads the provider but never writes", async () => {
    stubSelect();
    stubUpdate();
    const { calls } = stubClient();

    const res = await app().request("/chg-1/revert");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { revertible: boolean; revertibleFields: string[] };
    };
    expect(body.plan.revertible).toBe(true);
    expect(body.plan.revertibleFields).toEqual(["size"]);
    expect(calls).toEqual(["buildClient", "getResource"]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses a non-editable field without contacting the provider twice", async () => {
    stubSelect({ ...CHANGE, diff: [{ field: "region", from: "nyc1", to: "nyc3" }] });
    stubUpdate();
    stubClient();

    const res = await app().request("/chg-1/revert");
    const body = (await res.json()) as { plan: { fields: { status: string }[] } };
    expect(body.plan.fields[0]!.status).toBe("not-writable");
  });
});
