import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthSession } from "@/api/auth-middleware";

const mockSelect = vi.fn();
const mockGetPlugin = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

vi.mock("@/plugins/loader", () => ({
  getPlugin: (...args: unknown[]) => mockGetPlugin(...args),
}));

const { searchRoutes } = await import("@/api/routes/search");

function chainMock(result: unknown) {
  const where = vi.fn().mockResolvedValue(result);
  const from = vi.fn().mockReturnValue({ where });
  return { from, where };
}

function buildApp() {
  const app = new Hono();
  const session: AuthSession = {
    userId: "user-1",
    email: "test@example.com",
  };
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    return next();
  });
  app.route("/", searchRoutes);
  return app;
}

describe("Search routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("humanizes missing plugin and resource-type labels in search results", async () => {
    const resourcesRows = [
      {
        id: "res-1",
        pluginId: "unknownPlugin",
        resourceTypeId: "databaseInstance",
        accountId: "acct-1",
        displayName: "Primary DB",
        fieldsJson: "{}",
      },
    ];
    const accountsRows = [{ id: "acct-1", displayName: "Prod Account", pluginId: "unknownPlugin" }];
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return selectCallCount === 1 ? chainMock(resourcesRows) : chainMock(accountsRows);
    });
    mockGetPlugin.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.request("/?q=unknown plugin database instance", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].pluginLabel).toBe("Unknown Plugin");
    expect(body[0].resourceTypeLabel).toBe("Database Instance");
    expect(body[0]).not.toHaveProperty("pluginDisplayName");
    expect(body[0]).not.toHaveProperty("resourceTypeDisplayLabel");
  });
});
