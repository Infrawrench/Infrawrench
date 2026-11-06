import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInstanceRateCache,
  type CreateResourceConfig,
  type InstancePricingHostServices,
} from "@infrawrench/plugin-base";
import type { AwsCredentials } from "../auth.js";
import { estimateAwsCost } from "../cost-estimate.js";
import { withCurrentInstanceSizes } from "../instance-sizes.js";
import { clearEc2PriceCache, fetchEc2MonthlyPrices } from "../pricing.js";

const signed = vi.hoisted(() => ({ fetchSigned: vi.fn() }));
vi.mock("../signed-request.js", () => ({ fetchSigned: signed.fetchSigned }));

const credentials: AwsCredentials = {
  accessKeyId: "test",
  secretAccessKey: "test",
  region: "us-east-1",
};

/** A warehouse answering every rate query with the rows given. */
function warehouse(rows: [string, number][]): InstancePricingHostServices {
  return {
    query: vi.fn(async () => ({
      columns: [
        { name: "instanceType", type: "String" },
        { name: "hourly", type: "Float64" },
      ],
      rows,
      truncated: false,
      elapsedMs: 1,
    })),
  };
}

const down: InstancePricingHostServices = {
  query: vi.fn(async () => {
    throw new Error("down");
  }),
};

beforeEach(() => {
  clearInstanceRateCache();
  clearEc2PriceCache();
  signed.fetchSigned.mockReset();
  // Without the pricing permission, the live API answers with an error.
  signed.fetchSigned.mockRejectedValue(new Error("AccessDenied"));
});

describe("fetchEc2MonthlyPrices", () => {
  it("prices every size in one warehouse query, with no AWS call", async () => {
    const pricing = warehouse([
      ["a.large", 0.1],
      ["b.large", 0.2],
    ]);
    const prices = await fetchEc2MonthlyPrices(
      credentials,
      "eu-west-1",
      ["a.large", "b.large", "c.large"],
      pricing,
    );
    expect(prices).toEqual({ "a.large": 73, "b.large": 146 });
    expect(pricing.query).toHaveBeenCalledTimes(1);
    expect(signed.fetchSigned).not.toHaveBeenCalled();
  });

  it("falls back to the Price List API when the warehouse cannot answer", async () => {
    await fetchEc2MonthlyPrices(credentials, "eu-west-1", ["a.large"], down);
    expect(signed.fetchSigned).toHaveBeenCalledTimes(1);
  });
});

describe("estimateAwsCost with a warehouse", () => {
  it("quotes an instance with no pricing permission, and says the volume is missing", async () => {
    const estimate = await estimateAwsCost(
      credentials,
      "ec2-instance",
      { region: "eu-west-1", instanceType: "a.large" },
      warehouse([["a.large", 0.1]]),
    );
    expect(estimate?.monthlyAmount).toBe(73);
    expect(estimate?.partial).toBe(true);
  });

  it("filters on the engine and deployment the database runs", async () => {
    const pricing = warehouse([["db.m5.large", 1]]);
    const estimate = await estimateAwsCost(
      credentials,
      "rds-instance",
      { region: "us-east-1", instanceClass: "db.m5.large", engine: "oracle-se2", multiAZ: "true" },
      pricing,
    );
    expect(estimate?.monthlyAmount).toBe(730);
    const [sql] = vi.mocked(pricing.query).mock.calls[0]!;
    expect(sql).toContain("database_engine IN ('Oracle', '')");
    expect(sql).toContain("database_edition IN ('Standard Two', '')");
    expect(sql).toContain("deployment_option IN ('Multi-AZ', '')");
    // An open license would quote the far cheaper row a licensed engine also has.
    expect(sql).toContain("license_model IN ('License included', '')");
    expect(estimate?.notes?.join(" ")).toMatch(/Priced as license included/);
  });

  it("does not price an engine it cannot name", async () => {
    const estimate = await estimateAwsCost(
      credentials,
      "rds-instance",
      { region: "us-east-1", instanceClass: "db.m5.large", engine: "new-engine" },
      warehouse([["db.m5.large", 1]]),
    );
    expect(estimate).toBeNull();
  });

  it.each([
    ["elasticache-cluster", { cacheNodeType: "n", numCacheNodes: "3" }],
    ["elasticache-cluster", { nodeType: "n", numNodes: "3" }],
    ["opensearch-domain", { instanceType: "n", instanceCount: "3" }],
    ["redshift-cluster", { nodeType: "n", numberOfNodes: "3" }],
  ])("multiplies %s by its node count, form or lister spelling", async (typeId, fields) => {
    const estimate = await estimateAwsCost(
      credentials,
      typeId,
      { region: "us-east-1", ...fields },
      warehouse([["n", 1]]),
    );
    expect(estimate?.monthlyAmount).toBe(730 * 3);
  });

  it("does not call AWS once per size for a whole catalog when the warehouse is down", async () => {
    const sizes = Array.from({ length: 1400 }, (_, i) => `f${i}.large`);
    expect(await fetchEc2MonthlyPrices(credentials, "us-east-1", sizes, down)).toEqual({});
    expect(signed.fetchSigned).not.toHaveBeenCalled();
  });

  it("still quotes nothing without either source", async () => {
    expect(
      await estimateAwsCost(credentials, "redshift-cluster", {
        nodeType: "n",
        region: "us-east-1",
      }),
    ).toBeNull();
  });
});

describe("withCurrentInstanceSizes", () => {
  const config: CreateResourceConfig = {
    fields: [
      { key: "name", label: "Name", kind: "text", required: true },
      {
        key: "instanceClass",
        label: "Instance Class",
        kind: "select",
        required: true,
        options: [{ id: "db.t3.micro", label: "db.t3.micro" }],
        defaultValue: "db.t3.micro",
      },
    ],
  };
  const catalog: InstancePricingHostServices = {
    query: vi.fn(async () => ({
      columns: ["instanceType", "family", "category", "architecture", "vcpu", "memoryGib"].map(
        (name) => ({ name, type: "String" }),
      ),
      rows: [
        ["db.r8g.large", "r8g", "Memory optimized", "arm64", 2, 16],
        ["db.m8g.large", "m8g", "General purpose", "arm64", 2, 8],
        ["db.t4g.micro", "t4g", "General purpose", "arm64", 2, 1],
      ],
      truncated: false,
      elapsedMs: 1,
    })),
  };

  it("swaps a static select for the provider's current sizes, keeping the default", async () => {
    const out = await withCurrentInstanceSizes(catalog, "rds-instance", config);
    const field = out.fields.find((f) => f.key === "instanceClass")!;
    expect(field.kind).toBe("size-picker");
    expect(field.options).toBeUndefined();
    expect(field.defaultValue).toBe("db.t3.micro");
    // General purpose first, burstable leading it.
    expect(field.sizes?.map((s) => s.id)).toEqual(["db.t4g.micro", "db.m8g.large", "db.r8g.large"]);
    expect(field.sizes?.[0]).toMatchObject({
      vcpus: 2,
      memoryMb: 1024,
      category: "T4g · General purpose (arm64)",
    });
  });

  it("keeps the form's own list without a warehouse, or when it is down", async () => {
    expect(await withCurrentInstanceSizes(undefined, "rds-instance", config)).toBe(config);
    expect(await withCurrentInstanceSizes(down, "rds-instance", config)).toBe(config);
  });

  it("orders families newest first, and names one the warehouse leaves blank", async () => {
    const pricing: InstancePricingHostServices = {
      query: vi.fn(async () => ({
        columns: ["instanceType", "family", "category", "architecture", "vcpu", "memoryGib"].map(
          (name) => ({ name, type: "String" }),
        ),
        rows: [
          ["t2.micro", "t2", "General purpose", "x86_64", 1, 1],
          ["t4g.micro", "t4g", "General purpose", "arm64", 2, 1],
          ["t3.micro", "t3", "General purpose", "x86_64", 2, 1],
          ["m8g.large", "m8g", "General purpose", "arm64", 2, 8],
          ["ra3.xlplus", "", "", "", 4, 32],
        ],
        truncated: false,
        elapsedMs: 1,
      })),
    };
    const out = await withCurrentInstanceSizes(pricing, "ec2-instance", {
      fields: [
        { key: "instanceType", label: "Type", kind: "size-picker", required: true, sizes: [] },
      ],
    });
    const sizes = out.fields[0]!.sizes!;
    expect(sizes.map((s) => s.id)).toEqual([
      "t4g.micro",
      "t3.micro",
      "t2.micro",
      "m8g.large",
      "ra3.xlplus",
    ]);
    expect(sizes[4]!.category).toBe("Ra3");
  });

  it("does not offer node types AWS will refuse", async () => {
    const pricing: InstancePricingHostServices = {
      query: vi.fn(async () => ({
        columns: ["instanceType", "family", "category", "architecture", "vcpu", "memoryGib"].map(
          (name) => ({ name, type: "String" }),
        ),
        rows: [
          ["dc2.large", "dc2", "", "", 2, 15],
          ["ra3.large", "ra3", "", "", 2, 16],
        ],
        truncated: false,
        elapsedMs: 1,
      })),
    };
    const out = await withCurrentInstanceSizes(pricing, "redshift-cluster", {
      fields: [{ key: "nodeType", label: "Node", kind: "select", required: true, options: [] }],
    });
    expect(out.fields[0]!.sizes!.map((s) => s.id)).toEqual(["ra3.large"]);
  });

  it("leaves other types alone", async () => {
    expect(await withCurrentInstanceSizes(catalog, "s3-bucket", config)).toBe(config);
  });
});
