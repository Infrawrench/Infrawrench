import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();
vi.mock("@/db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));
vi.mock("@/db/schema", () => ({
  auditLogs: {
    id: "id",
    organizationId: "org",
    action: "action",
    entityType: "et",
    userId: "uid",
    createdAt: "ts",
  },
  users: { id: "id", displayName: "dn", email: "email" },
}));
vi.mock("@infrawrench/server-core/permissions/catalog", () => ({ hasPermission: () => true }));

const { auditRoutes } = await import("@/api/routes/audit");
const buildApp = () => buildTestApp(auditRoutes);

describe("Audit routes", () => {
  beforeEach(() => vi.clearAllMocks());

  function setup(entries: unknown[], count: number) {
    // count query
    const countWhere = vi.fn().mockResolvedValue([{ count }]);
    const countFrom = vi.fn().mockReturnValue({ where: countWhere });
    // entries query
    const offset = vi.fn().mockResolvedValue(entries);
    const limit = vi.fn().mockReturnValue({ offset });
    const orderBy = vi.fn().mockReturnValue({ limit });
    const entriesWhere = vi.fn().mockReturnValue({ orderBy });
    const leftJoin = vi.fn().mockReturnValue({ where: entriesWhere });
    const entriesFrom = vi.fn().mockReturnValue({ leftJoin });
    mockSelect.mockReturnValueOnce({ from: countFrom }).mockReturnValueOnce({ from: entriesFrom });
    return { limit, offset };
  }

  it("returns paginated entries with total", async () => {
    setup([{ id: "l1", action: "create" }], 1);
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.entries).toHaveLength(1);
  });

  it("applies page/pageSize via limit and offset", async () => {
    const { limit, offset } = setup([], 0);
    await buildApp().request("/?page=3&pageSize=10");
    expect(limit).toHaveBeenCalledWith(10);
    expect(offset).toHaveBeenCalledWith(20);
  });

  it("accepts action/entityType/userId/from/to filters without error", async () => {
    setup([], 0);
    const res = await buildApp().request(
      "/?action=create&entityType=resource&userId=u1&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
  });

  it("returns 0 total when count result missing", async () => {
    const countWhere = vi.fn().mockResolvedValue([]);
    const countFrom = vi.fn().mockReturnValue({ where: countWhere });
    const offset = vi.fn().mockResolvedValue([]);
    const limit = vi.fn().mockReturnValue({ offset });
    const orderBy = vi.fn().mockReturnValue({ limit });
    const entriesWhere = vi.fn().mockReturnValue({ orderBy });
    const leftJoin = vi.fn().mockReturnValue({ where: entriesWhere });
    const entriesFrom = vi.fn().mockReturnValue({ leftJoin });
    mockSelect.mockReturnValueOnce({ from: countFrom }).mockReturnValueOnce({ from: entriesFrom });

    const res = await buildApp().request("/");
    expect((await res.json()).total).toBe(0);
  });
});
