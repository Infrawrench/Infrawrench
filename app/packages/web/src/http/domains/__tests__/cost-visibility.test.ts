import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi, type TestCaller } from "@/http/testing";

// Every query answers from a queue, in the order the handler makes them;
// chain methods return the chain, and awaiting it yields the next rows.
let selectQueue: unknown[][] = [];
let deleteRows: unknown[] = [];
const inserted: unknown[] = [];

function chain(rows: () => unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "onConflictDoUpdate"]) {
    c[m] = () => c;
  }
  c["values"] = (v: unknown) => {
    inserted.push(v);
    return c;
  };
  c["returning"] = () => c;
  c["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rows()).then(res, rej);
  return c;
}

const stored = {
  id: "s1",
  organizationId: "org-1",
  principalKind: "api_key",
  principalId: "k1",
  costCentreIds: [],
  accountIds: [],
  savedFilterId: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};

vi.mock("@/db/client", () => ({
  db: {
    select: () => chain(() => selectQueue.shift() ?? []),
    insert: () => chain(() => [stored]),
    delete: () => chain(() => deleteRows),
  },
}));
vi.mock("@infrawrench/server-core/cost/allocation", () => ({ listCostCentres: async () => [] }));
vi.mock("@infrawrench/server-core/cost/saved-filters", () => ({
  SavedCostFilterResolutionError: class extends Error {},
  resolveSavedCostFilters: async () => undefined,
}));
const logAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

const { costVisibilityDomain } = await import("@/http/domains/cost-visibility/index");

const app = (caller: Omit<TestCaller, "basePath"> = {}) =>
  buildTestApi(costVisibilityDomain, { basePath: "/api/org/org-1/cost-visibility", ...caller });

const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

describe("cost visibility routes", () => {
  beforeEach(() => {
    selectQueue = [];
    deleteRows = [];
    inserted.length = 0;
    vi.clearAllMocks();
  });

  it("lists labelled scopes behind team:read", async () => {
    selectQueue.push([stored], [{ id: "k1", label: "CI key" }]);
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      scopes: [
        expect.objectContaining({
          id: "s1",
          principalKind: "api_key",
          principalLabel: "CI key",
          createdAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
    });
    const denied = await app({ permissions: ["costs:read"] }).request("/");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Missing permission: team:read" });
  });

  it("refuses a body that is not a scope, with the field's sentence", async () => {
    const notObject = await app().request("/", { method: "PUT", body: "nope" });
    expect(notObject.status).toBe(400);
    expect(await notObject.json()).toEqual({ error: "Expected a JSON object." });

    const kind = await app().request("/", put({ principalKind: "team", principalId: "x" }));
    expect(await kind.json()).toEqual({
      error: "principalKind must be role, member or api_key.",
    });

    const ids = await app().request(
      "/",
      put({ principalKind: "role", principalId: "r1", accountIds: ["a", ""] }),
    );
    expect(ids.status).toBe(400);
    expect(await ids.json()).toEqual({ error: "accountIds must be a list of ids." });
  });

  it("needs team:role:write to scope a role", async () => {
    const res = await app({ permissions: ["apikeys:write"] }).request(
      "/",
      put({ principalKind: "role", principalId: "r1" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: team:role:write" });
  });

  it("refuses the owner role", async () => {
    selectQueue.push([{ systemKey: "owner" }]);
    const res = await app().request("/", put({ principalKind: "role", principalId: "r1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The Owner role always sees all costs and cannot be scoped.",
    });
    expect(inserted).toHaveLength(0);
  });

  it("lets a key's own owner scope it with apikeys:write", async () => {
    selectQueue.push([{ userId: "user-1" }], [{ id: "k1", label: "CI key" }]);
    const res = await app({ permissions: ["apikeys:write"] }).request(
      "/",
      put({ principalKind: "api_key", principalId: "k1" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { principalLabel: string }).principalLabel).toBe("CI key");
    expect(inserted).toEqual([
      expect.objectContaining({ principalKind: "api_key", principalId: "k1", accountIds: [] }),
    ]);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_visibility.update", entityId: "s1" }),
    );
  });

  it("refuses someone else's key without team:role:write", async () => {
    selectQueue.push([{ userId: "user-2" }]);
    const res = await app({ permissions: ["apikeys:write"] }).request(
      "/",
      put({ principalKind: "api_key", principalId: "k1" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Missing permission: team:role:write (or apikeys:write on your own key)",
    });
  });

  it("404s a revoked or unknown key", async () => {
    selectQueue.push([]);
    const res = await app({ permissions: ["apikeys:write"] }).request(
      "/",
      put({ principalKind: "api_key", principalId: "gone" }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "API key not found." });
  });

  it("removes a scope with team:role:write without looking the principal up", async () => {
    deleteRows = [{ id: "s1" }];
    const res = await app().request("/member/u2", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cost_visibility.delete",
        metadata: { principalKind: "member", principalId: "u2" },
      }),
    );
  });

  it("checks the principal on remove without team:role:write", async () => {
    const res = await app({ permissions: ["apikeys:write"] }).request("/member/u2", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: team:role:write" });
  });

  it("refuses an unknown principal kind and 404s a missing scope", async () => {
    const kind = await app().request("/team/x", { method: "DELETE" });
    expect(kind.status).toBe(400);
    expect(await kind.json()).toEqual({ error: "principalKind must be role, member or api_key." });

    const missing = await app().request("/role/r1", { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });
  });
});
