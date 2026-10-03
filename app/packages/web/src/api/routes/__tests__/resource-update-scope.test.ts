import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { buildTestApp } from "./test-utils";

/**
 * POST /api/resources/update runs the provider edit against the caller's own
 * account, which acts on the external id alone, then mirrors the result into
 * the `resources` row keyed by the id the caller sent. The id's account prefix
 * must therefore match the checked account, and the mirror write must be
 * scoped to the caller's org, or an edit of one's own resource lands in
 * another org's row.
 */

const updateWheres: SQL[] = [];
const mockUpdate = vi.fn(() => ({
  set: () => ({
    where: (where: SQL) => {
      updateWheres.push(where);
      return Promise.resolve([]);
    },
  }),
}));
const dbMock = { db: { update: mockUpdate } };
vi.mock("../../../db/client", () => dbMock);
vi.mock("@infrawrench/server-core/db/client", () => dbMock);

const updateResource = vi.fn(async (typeId: string, resourceId: string, accountId: string) => ({
  id: resourceId,
  pluginId: "hetzner",
  resourceTypeId: typeId,
  accountId,
  displayName: "renamed",
  fields: { name: "renamed" },
  resolvedOutputs: { ip: "1.2.3.4" },
}));
const getClientForResource = vi.fn(async (_pluginId: string, accountId: string, orgId: string) =>
  accountId === "acct-1" && orgId === "org-1"
    ? { client: { updateResource }, account: { id: "acct-1", pluginId: "hetzner" } }
    : null,
);
vi.mock("../../../services/plugin-clients", () => ({
  getClientForResource,
  getClientForAccount: vi.fn(),
}));
vi.mock("../../../services/change-freezes", () => ({
  checkChangeFreeze: vi.fn(async () => null),
}));
vi.mock("../../../services/audit", () => ({ logAudit: vi.fn() }));

const { Hono } = await import("hono");
const { registerLifecycleRoutes } = await import("../resource-detail/lifecycle");

function buildApp() {
  const routes = new Hono();
  registerLifecycleRoutes(routes);
  return buildTestApp(routes);
}

function post(body: Record<string, unknown>) {
  return buildApp().request("/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: "acct-1",
      pluginId: "hetzner",
      resourceTypeId: "server",
      fields: { name: "renamed" },
      ...body,
    }),
  });
}

beforeEach(() => {
  updateWheres.length = 0;
  vi.clearAllMocks();
});

describe("POST /update org scoping", () => {
  it("rejects a resource id whose account prefix is not the checked account", async () => {
    const res = await post({ resourceId: "acct-of-another-org:server:42" });
    expect(res.status).toBe(404);
    // Neither the provider nor the database is touched.
    expect(updateResource).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not let a prefix that merely starts with the account id through", async () => {
    const res = await post({ resourceId: "acct-10:server:42" });
    expect(res.status).toBe(404);
    expect(updateResource).not.toHaveBeenCalled();
  });

  it("mirrors the edit only into the caller's own row", async () => {
    const res = await post({ resourceId: "acct-1:server:42" });
    expect(res.status).toBe(200);
    expect(updateResource).toHaveBeenCalledWith("server", "acct-1:server:42", "acct-1", {
      name: "renamed",
    });
    expect(updateWheres).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(updateWheres[0]!);
    expect(sql).toContain('"resources"."id" = $1');
    expect(sql).toContain('"resources"."organization_id" = $2');
    expect(sql).toContain('"resources"."account_id" = $3');
    expect(params).toEqual(["acct-1:server:42", "org-1", "acct-1"]);
  });
});
