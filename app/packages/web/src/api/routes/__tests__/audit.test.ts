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
    apiKeyId: "api_key_id",
    createdAt: "ts",
  },
  users: { id: "id", displayName: "dn", email: "email" },
  apiKeys: { id: "id", name: "name", prefix: "prefix" },
}));
vi.mock("@infrawrench/server-core/permissions/catalog", () => ({ hasPermission: () => true }));

const { auditRoutes } = await import("@/api/routes/audit");
const buildApp = () => buildTestApp(auditRoutes);

describe("Audit routes", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The entries query joins `users` and `api_keys`, so `leftJoin` has to be
   * chainable with itself before `where` is reachable.
   */
  function setup(entries: unknown[], count: number | null) {
    // count query
    const countWhere = vi.fn().mockResolvedValue(count === null ? [] : [{ count }]);
    const countFrom = vi.fn().mockReturnValue({ where: countWhere });
    // entries query
    const offset = vi.fn().mockResolvedValue(entries);
    const limit = vi.fn().mockReturnValue({ offset });
    const orderBy = vi.fn().mockReturnValue({ limit });
    const entriesWhere = vi.fn().mockReturnValue({ orderBy });
    const joined: { leftJoin: ReturnType<typeof vi.fn>; where: typeof entriesWhere } = {
      leftJoin: vi.fn(),
      where: entriesWhere,
    };
    joined.leftJoin.mockReturnValue(joined);
    const entriesFrom = vi.fn().mockReturnValue(joined);
    mockSelect.mockReturnValueOnce({ from: countFrom }).mockReturnValueOnce({ from: entriesFrom });
    return { limit, offset, leftJoin: joined.leftJoin, entriesWhere, countWhere };
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
    setup([], null);
    const res = await buildApp().request("/");
    expect((await res.json()).total).toBe(0);
  });

  /**
   * "Which key did this?" is the question an operator asks after a credential
   * leaks. `userId` cannot answer it — a person and every key they minted share
   * one user id — so the filter has to be on the key itself.
   */
  it("filters by apiKeyId", async () => {
    const { entriesWhere } = setup([], 0);
    const res = await buildApp().request("/?apiKeyId=key-1");
    expect(res.status).toBe(200);
    expect(entriesWhere).toHaveBeenCalled();
  });

  it("joins the key so an entry carries its name and prefix", async () => {
    const { leftJoin } = setup(
      [{ id: "l1", apiKeyId: "key-1", apiKeyName: "ci-deploy", apiKeyPrefix: "iwk_abc1" }],
      1,
    );
    const res = await buildApp().request("/");
    // users and api_keys.
    expect(leftJoin).toHaveBeenCalledTimes(2);
    expect((await res.json()).entries[0]).toMatchObject({
      apiKeyName: "ci-deploy",
      apiKeyPrefix: "iwk_abc1",
    });
  });
});
