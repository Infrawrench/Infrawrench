import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();
vi.mock("@/db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));
vi.mock("@/db/schema", () => ({
  accounts: {
    id: "id",
    displayName: "dn",
    pluginId: "pid",
    organizationId: "org",
    deletedAt: "del",
  },
  resources: {
    id: "id",
    pluginId: "pid",
    resourceTypeId: "rt",
    accountId: "aid",
    displayName: "dn",
    fieldsJson: "fj",
    organizationId: "org",
    deletedAt: "del",
  },
}));

const mockGetPlugin = vi.fn();
vi.mock("@/plugins/loader", () => ({ getPlugin: (...a: unknown[]) => mockGetPlugin(...a) }));

vi.mock("@infrawrench/server-core/permissions/catalog", () => ({
  hasPermission: () => true,
}));

const { searchRoutes } = await import("@/api/routes/search");
const buildApp = () => buildTestApp(searchRoutes);

function selectResolving(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

describe("Search routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns matching resources enriched with plugin metadata", async () => {
    mockSelect
      .mockReturnValueOnce(
        selectResolving([
          {
            id: "r1",
            pluginId: "aws",
            resourceTypeId: "ec2",
            accountId: "a1",
            displayName: "prod-web",
            fieldsJson: {},
          },
        ]),
      )
      .mockReturnValueOnce(selectResolving([{ id: "a1", displayName: "Prod", pluginId: "aws" }]));

    mockGetPlugin.mockResolvedValue({
      plugin: {
        manifest: { displayName: "AWS", logoSvg: "<svg/>" },
        resourceTypes: [{ id: "ec2", displayName: "EC2 Instance" }],
      },
    });

    const res = await buildApp().request("/?q=prod");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].pluginDisplayName).toBe("AWS");
    expect(body[0].resourceTypeLabel).toBe("EC2 Instance");
  });

  it("filters out resources not matching the query", async () => {
    mockSelect
      .mockReturnValueOnce(
        selectResolving([
          {
            id: "r1",
            pluginId: "aws",
            resourceTypeId: "ec2",
            accountId: "a1",
            displayName: "web",
            fieldsJson: {},
          },
        ]),
      )
      .mockReturnValueOnce(selectResolving([{ id: "a1", displayName: "Prod", pluginId: "aws" }]));
    mockGetPlugin.mockResolvedValue({
      plugin: { manifest: { displayName: "AWS", logoSvg: "" }, resourceTypes: [] },
    });

    const res = await buildApp().request("/?q=zzz-nomatch");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("falls back to plugin id when plugin not loaded", async () => {
    mockSelect
      .mockReturnValueOnce(
        selectResolving([
          {
            id: "r1",
            pluginId: "ghost",
            resourceTypeId: "x",
            accountId: "a1",
            displayName: "n",
            fieldsJson: {},
          },
        ]),
      )
      .mockReturnValueOnce(selectResolving([]));
    mockGetPlugin.mockResolvedValue(null);

    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].pluginDisplayName).toBe("ghost");
    expect(body[0].resourceTypeLabel).toBe("x");
  });
});
