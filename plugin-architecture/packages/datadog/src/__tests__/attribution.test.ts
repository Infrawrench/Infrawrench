import { describe, expect, it } from "vitest";
import { fetchCostAttribution, type CostAttributionReport } from "../attribution.js";
import { mapOrganization } from "../mappers.js";
import { ATTRIBUTION_KEY, renderDatadogDetail } from "../render.js";
import { ctxWith, makeHttp } from "./helpers.js";

const NOW = Date.parse("2026-10-19T00:00:00Z");

const entry = (orgName: string) => ({
  attributes: { org_name: orgName, values: { infra_host_total_cost: 10 } },
});

const pageOf = (orgName: string, next: string | null) => ({
  body: { data: [entry(orgName)], meta: { pagination: { next_record_id: next } } },
});

describe("fetchCostAttribution with no tag keys configured", () => {
  it("follows the cursor past the first page", async () => {
    const { http, calls } = makeHttp((url) =>
      url.searchParams.get("next_record_id") === "n1"
        ? pageOf("Child", null)
        : pageOf("Parent", "n1"),
    );
    const report = await fetchCostAttribution(ctxWith(http), NOW);
    expect(report.rows.map((r) => r.orgName).sort()).toEqual(["Child", "Parent"]);
    expect(report.truncated).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("says when its page budget ran out", async () => {
    const { http, calls } = makeHttp(() => pageOf("Org", "again"));
    const report = await fetchCostAttribution(ctxWith(http), NOW);
    expect(report.truncated).toBe(true);
    expect(calls).toHaveLength(5);
  });
});

describe("the attribution note", () => {
  const report: CostAttributionReport = {
    month: "2026-09",
    tagKeys: [],
    rows: [],
    truncated: true,
  };

  it("says the table is partial whether or not tag keys are configured", () => {
    const render = (attribution: CostAttributionReport) =>
      JSON.stringify(
        renderDatadogDetail(
          {
            ...mapOrganization("acc", { publicId: "p1", name: "Acme" }),
            resolvedOutputs: { [ATTRIBUTION_KEY]: JSON.stringify(attribution) },
          },
          "https://app.datadoghq.com",
        ),
      );
    expect(render(report)).toContain("Showing the first pages only");
    expect(render({ ...report, tagKeys: ["team"] })).toContain("Showing the first pages only");
  });
});
