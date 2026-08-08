import { describe, it, expect } from "vitest";
import { buildCostExportQuery, resolveColumns, tagColumnName } from "../cost-exports/rows";
import { csvCell, outputColumns, toCsv, toNdjson } from "../cost-exports/serialize";
import type { CostExportRow } from "../cost-exports/rows";

const stamp = { exportedAt: "2026-08-08T04:00:00.000Z", collectionWatermark: "2026-08-06" };

async function* rows(...list: CostExportRow[]): AsyncGenerator<CostExportRow> {
  for (const r of list) yield r;
}

async function collect(body: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const piece of body) out += piece;
  return out;
}

describe("resolveColumns", () => {
  it("drops the bare `tag` dimension — a tag export names its keys instead", () => {
    const columns = resolveColumns({ dimensions: ["provider", "tag"], tagKeys: ["team"] });
    expect(columns.dimensions).toEqual(["provider"]);
    expect(columns.tagColumns).toEqual(["tag_team"]);
  });

  it("de-duplicates", () => {
    expect(resolveColumns({ dimensions: ["service", "service"], tagKeys: ["a", "a"] })).toEqual({
      dimensions: ["service"],
      tagColumns: ["tag_a"],
    });
  });
});

describe("tagColumnName", () => {
  it("makes a warehouse-safe column name", () => {
    expect(tagColumnName("cost-centre")).toBe("tag_cost_centre");
    expect(tagColumnName("aws:createdBy")).toBe("tag_aws_createdBy");
  });
});

describe("buildCostExportQuery", () => {
  const base = {
    organizationId: "org-1",
    from: "2026-08-01",
    to: "2026-08-07",
    dimensions: ["provider", "service"],
    tagKeys: ["team"],
    filters: [],
  };

  it("orders by the full grouping key so two runs produce identical bytes", () => {
    const { sql } = buildCostExportQuery(base);
    expect(sql).toContain("GROUP BY day, provider, service, tag_team, currency");
    expect(sql).toContain("ORDER BY day, provider, service, tag_team, currency");
  });

  it("reads through FINAL so restated rows never double-count", () => {
    expect(buildCostExportQuery(base).sql).toContain("FROM cost_daily FINAL");
  });

  it("binds the org and range rather than interpolating them", () => {
    const { sql, params } = buildCostExportQuery(base);
    expect(sql).toContain("organization_id = {orgId:String}");
    expect(params).toMatchObject({ orgId: "org-1", from: "2026-08-01", to: "2026-08-07" });
  });

  it("suppresses a usage unit the grouped rows disagree on", () => {
    expect(buildCostExportQuery(base).sql).toContain("uniqExact(usage_unit) = 1");
  });

  it("sums the amortized column when asked, with the cash fallback", () => {
    const { sql } = buildCostExportQuery({ ...base, costBasis: "amortized" });
    expect(sql).toContain("if(amortized_amount != 0, amortized_amount, amount)");
  });

  it("translates filters, including tag filters, into bound predicates", () => {
    const { sql, params } = buildCostExportQuery({
      ...base,
      filters: [
        { dimension: "account", op: "in", values: ["acct-1"] },
        { dimension: "tag", op: "not_in", values: ["retired"], tagKey: "state" },
      ],
    });
    expect(sql).toContain("account_id IN {fvals0:Array(String)}");
    expect(sql).toContain("tags[{ftag1:String}] NOT IN {fvals1:Array(String)}");
    expect(params["fvals0"]).toEqual(["acct-1"]);
    expect(params["ftag1"]).toBe("state");
  });

  it("narrows charge types only when asked", () => {
    expect(buildCostExportQuery(base).sql).not.toContain("charge_type IN");
    expect(buildCostExportQuery({ ...base, chargeTypes: ["credit"] }).sql).toContain(
      "charge_type IN {chargeTypes:Array(String)}",
    );
  });
});

describe("csvCell", () => {
  it("leaves plain values alone", () => {
    expect(csvCell("ec2")).toBe("ec2");
    expect(csvCell(12.5)).toBe("12.5");
  });

  it("quotes and escapes anything that would break the row", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("renders an absent value as empty rather than the string undefined", () => {
    expect(csvCell(undefined)).toBe("");
  });
});

describe("outputColumns", () => {
  it("always ends with the two provenance columns", () => {
    expect(outputColumns({ dimensions: ["provider"], tagColumns: ["tag_team"] })).toEqual([
      "day",
      "provider",
      "tag_team",
      "currency",
      "amount",
      "usage_amount",
      "usage_unit",
      "exported_at",
      "collection_watermark",
    ]);
  });
});

describe("toCsv", () => {
  const columns = { dimensions: ["provider"], tagColumns: ["tag_team"] };

  it("writes a header then one line per row, each stamped with provenance", async () => {
    const out = await collect(
      toCsv(
        rows({
          day: "2026-08-05",
          provider: "aws",
          tag_team: "platform",
          currency: "USD",
          amount: 12.5,
          usage_amount: 3,
          usage_unit: "Hrs",
        }),
        columns,
        stamp,
      ),
    );
    expect(out).toBe(
      "day,provider,tag_team,currency,amount,usage_amount,usage_unit,exported_at,collection_watermark\n" +
        "2026-08-05,aws,platform,USD,12.5,3,Hrs,2026-08-08T04:00:00.000Z,2026-08-06\n",
    );
  });

  it("still emits a header for an empty period, so the object is loadable", async () => {
    const out = await collect(toCsv(rows(), columns, stamp));
    expect(out.split("\n")).toHaveLength(2);
    expect(out.startsWith("day,provider")).toBe(true);
  });

  it("quotes a resource id containing a comma", async () => {
    const out = await collect(
      toCsv(
        rows({ day: "2026-08-05", provider: "arn:aws:x,y", currency: "USD", amount: 1 }),
        { dimensions: ["provider"], tagColumns: [] },
        stamp,
      ),
    );
    expect(out).toContain('"arn:aws:x,y"');
  });

  it("normalises string-typed sums to numbers", async () => {
    const out = await collect(
      toCsv(
        rows({ day: "2026-08-05", currency: "USD", amount: "1.5", usage_amount: "2" }),
        { dimensions: [], tagColumns: [] },
        stamp,
      ),
    );
    expect(out.split("\n")[1]).toBe("2026-08-05,USD,1.5,2,,2026-08-08T04:00:00.000Z,2026-08-06");
  });
});

describe("toNdjson", () => {
  it("writes one JSON object per line with the provenance fields", async () => {
    const out = await collect(
      toNdjson(
        rows({ day: "2026-08-05", provider: "gcp", currency: "EUR", amount: 4 }),
        { dimensions: ["provider"], tagColumns: [] },
        stamp,
      ),
    );
    expect(JSON.parse(out.trim())).toEqual({
      day: "2026-08-05",
      provider: "gcp",
      currency: "EUR",
      amount: 4,
      usage_amount: 0,
      usage_unit: "",
      exported_at: "2026-08-08T04:00:00.000Z",
      collection_watermark: "2026-08-06",
    });
  });

  it("emits nothing at all for an empty period", async () => {
    expect(await collect(toNdjson(rows(), { dimensions: [], tagColumns: [] }, stamp))).toBe("");
  });
});
