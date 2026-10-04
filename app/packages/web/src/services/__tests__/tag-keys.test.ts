import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCostTagKeys = vi.fn();
const mockGetCostTagKeyUsage = vi.fn();
const mockGetSettings = vi.fn();
let inventoryRows: Array<{
  pluginId: string;
  fieldsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
}> = [];

vi.mock("@infrawrench/server-core/clickhouse/cost-readers", () => ({
  getCostTagKeys: (...a: unknown[]) => mockGetCostTagKeys(...a),
  getCostTagKeyUsage: (...a: unknown[]) => mockGetCostTagKeyUsage(...a),
}));
vi.mock("@infrawrench/server-core/cost/tag-key-settings", () => ({
  getOrgTagKeySettings: (...a: unknown[]) => mockGetSettings(...a),
}));
vi.mock("../../db/client", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => inventoryRows,
  };
  return { db: { select: () => chain } };
});

const { discoverTagKeys, listPickerCostTagKeys, orderTagKeysForPicker } =
  await import("../tag-keys");

beforeEach(() => {
  vi.clearAllMocks();
  inventoryRows = [];
  mockGetSettings.mockResolvedValue({ hidden: ["aws:*"], preferred: ["team"] });
});

describe("listPickerCostTagKeys", () => {
  it("applies the settings to the cost data's keys", async () => {
    mockGetCostTagKeys.mockResolvedValue(["aws:createdBy", "env", "team"]);
    expect(await listPickerCostTagKeys("org-1")).toEqual([
      { value: "team", label: "team", preferred: true },
      { value: "env", label: "env" },
    ]);
  });
});

describe("orderTagKeysForPicker", () => {
  it("returns the visible keys and the preferred subset", () => {
    expect(
      orderTagKeysForPicker(["env", "aws:x", "team"], { hidden: ["aws:*"], preferred: ["team"] }),
    ).toEqual({ tagKeys: ["team", "env"], preferredTagKeys: ["team"] });
  });
});

describe("discoverTagKeys", () => {
  it("merges cost usage with inventory tags and flags hidden and preferred keys", async () => {
    mockGetCostTagKeyUsage.mockResolvedValue([
      {
        key: "aws:cloudformation:stack-id",
        pluginIds: ["aws"],
        rowCount: 900,
        resourceCount: 40,
        lastSeen: "2026-10-03",
      },
      { key: "env", pluginIds: ["aws"], rowCount: 50, resourceCount: 5, lastSeen: "2026-10-02" },
    ]);
    inventoryRows = [
      { pluginId: "gcp", fieldsJson: { labels: { env: "prod", team: "data" } }, outputsJson: {} },
      { pluginId: "aws", fieldsJson: {}, outputsJson: { tags: { team: "web" } } },
    ];

    const res = await discoverTagKeys("org-1", {
      includeCosts: true,
      now: new Date("2026-10-04T12:00:00Z"),
    });

    expect(mockGetCostTagKeyUsage).toHaveBeenCalledWith("org-1", "2026-07-06");
    expect(res.keys.map((k) => k.key)).toEqual(["team", "aws:cloudformation:stack-id", "env"]);
    const [team, stack, env] = res.keys;
    expect(team).toMatchObject({
      preferred: true,
      hidden: false,
      sources: ["resources"],
      providers: ["aws", "gcp"],
      inventoryCount: 2,
      lastSeen: null,
    });
    expect(stack).toMatchObject({ hidden: true, hiddenBy: "aws:*", costRowCount: 900 });
    expect(env).toMatchObject({
      sources: ["costs", "resources"],
      providers: ["aws", "gcp"],
      costRowCount: 50,
      costResourceCount: 5,
      inventoryCount: 1,
    });
    expect(res.lookbackDays).toBe(90);
    expect(res.truncated).toBe(false);
  });

  it("skips the cost read for callers without costs:read", async () => {
    await discoverTagKeys("org-1", { includeCosts: false });
    expect(mockGetCostTagKeyUsage).not.toHaveBeenCalled();
  });
});
