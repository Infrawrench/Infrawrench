import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { usageWindows } from "../cost-data.js";
import {
  estimateFor,
  FALLBACK_RATES,
  paidRate,
  shapeParts,
  sizeOptionsFromShapes,
} from "../pricing.js";
import { parseStatusFeed } from "../status-feed.js";
import { ociTerraformExport } from "../terraform.js";
import { makeResource } from "../listers.js";
import { identityRoute, makeClient, TENANCY } from "./helpers.js";

describe("cost collection", () => {
  it("splits a range into exclusive-end windows of at most 90 days", () => {
    expect(usageWindows({ fromDate: "2026-01-01", toDate: "2026-01-31" })).toEqual([
      { start: "2026-01-01", end: "2026-02-01" },
    ]);
    const long = usageWindows({ fromDate: "2025-10-01", toDate: "2026-09-30" });
    expect(long[0]).toEqual({ start: "2025-10-01", end: "2025-12-30" });
    expect(long.at(-1)!.end).toBe("2026-10-01");
    expect(long.every((w) => (Date.parse(w.end) - Date.parse(w.start)) / 86_400_000 <= 90)).toBe(
      true,
    );
  });

  it("emits billed daily rows with the compartment path stamped from a second pass", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { client } = makeClient((url, method, body) => {
      if (
        url.hostname === "usageapi.us-ashburn-1.oci.oraclecloud.com" &&
        url.pathname === "/20200107/usage"
      ) {
        const b = body as Record<string, unknown>;
        bodies.push(b);
        if (b["isAggregateByTime"]) {
          return {
            body: {
              items: [{ resourceId: "ocid1.instance.oc1.iad.a", compartmentPath: "acme/prod" }],
            },
          };
        }
        return {
          body: {
            items: [
              {
                timeUsageStarted: "2026-09-01T00:00:00.000Z",
                service: "Compute",
                skuName: "Compute - Standard - E4 - OCPU",
                region: "us-ashburn-1",
                resourceId: "ocid1.instance.oc1.iad.a",
                computedAmount: 1.2,
                computedQuantity: 48,
                unit: "OCPU Hours",
                currency: "USD",
              },
              {
                timeUsageStarted: "2026-09-01T00:00:00.000Z",
                service: "Object Storage",
                skuName: "Object Storage - Storage",
                region: "eu-frankfurt-1",
                resourceId: null,
                computedAmount: 0.4,
                currency: "USD",
              },
              {
                timeUsageStarted: "2026-09-02T00:00:00.000Z",
                service: "Compute",
                computedAmount: null,
              },
            ],
          },
        };
      }
      return identityRoute(url);
    });
    const rows = await client.fetchCostData("acct", {
      fromDate: "2026-09-01",
      toDate: "2026-09-02",
    });
    expect(rows).toEqual([
      {
        date: "2026-09-01",
        service: "Compute",
        region: "us-ashburn-1",
        resourceId: "ocid1.instance.oc1.iad.a",
        tags: { sku: "Compute - Standard - E4 - OCPU", compartment: "acme/prod" },
        currency: "USD",
        amount: 1.2,
        usageAmount: 48,
        usageUnit: "OCPU Hours",
      },
      {
        date: "2026-09-01",
        service: "Object Storage",
        region: "eu-frankfurt-1",
        tags: { sku: "Object Storage - Storage" },
        currency: "USD",
        amount: 0.4,
      },
    ]);
    expect(bodies[0]).toMatchObject({
      tenantId: TENANCY,
      timeUsageStarted: "2026-09-01T00:00:00Z",
      timeUsageEnded: "2026-09-03T00:00:00Z",
      granularity: "DAILY",
      queryType: "COST",
      groupBy: ["service", "skuName", "region", "resourceId"],
    });
    expect((bodies[0]!["groupBy"] as string[]).length).toBeLessThanOrEqual(4);
  });

  it("explains a missing usage-report policy as a setup error", async () => {
    const { client } = makeClient((url) =>
      url.hostname.startsWith("usageapi.")
        ? { status: 404, body: { code: "NotAuthorizedOrNotFound", message: "x" } }
        : identityRoute(url),
    );
    await expect(
      client.fetchCostData("acct", { fromDate: "2026-09-01", toDate: "2026-09-01" }),
    ).rejects.toBeInstanceOf(CostSetupError);
  });

  it("reports remaining Universal Credits per commitment line, skipping PAYG lines", async () => {
    const { client } = makeClient((url) => {
      if (url.hostname.startsWith("identity.") && url.pathname === "/20190111/subscriptions") {
        return {
          body: {
            items: [
              {
                currency: { isoCode: "EUR" },
                timeEnd: "2027-03-31T00:00:00Z",
                subscribedServices: [
                  {
                    id: "ss1",
                    product: { name: "Oracle Cloud Infrastructure Universal Credits" },
                    availableAmount: "8200.50",
                    totalValue: "12000",
                    timeEnd: "2027-03-31T00:00:00Z",
                  },
                  { id: "ss2", product: { name: "Pay as you go" } },
                ],
              },
            ],
          },
        };
      }
      return identityRoute(url);
    });
    expect(await client.fetchCreditBalance("acct")).toEqual([
      {
        key: "ss1",
        label: "Oracle Cloud Infrastructure Universal Credits",
        remaining: 8200.5,
        currency: "EUR",
        granted: 12000,
        expiresAt: "2027-03-31T00:00:00Z",
      },
    ]);
  });
});

describe("pricing", () => {
  it("reads the paid tier of a tiered price list item", () => {
    expect(
      paidRate({
        partNumber: "B93297",
        currencyCodeLocalizations: [
          {
            currencyCode: "USD",
            prices: [
              { model: "PAY_AS_YOU_GO", value: 0, rangeMin: 0 },
              { model: "PAY_AS_YOU_GO", value: 0.01, rangeMin: 3000 },
            ],
          },
        ],
      }),
    ).toBe(0.01);
  });

  it("maps shapes to their OCPU and memory parts", () => {
    expect(shapeParts("VM.Standard.E4.Flex")).toMatchObject({ ocpu: "B93113", memory: "B93114" });
    expect(shapeParts("VM.Standard.A1.Flex")).toMatchObject({ ocpu: "B93297", vcpusPerOcpu: 1 });
    expect(shapeParts("VM.Standard.E6.Flex")).toMatchObject({ ocpu: "B111129" });
    expect(shapeParts("VM.Standard2.4")).toMatchObject({ ocpu: "B88514" });
    expect(shapeParts("VM.Standard.E2.1.Micro")).toBeNull();
    expect(shapeParts("VM.GPU.A10.1")).toBeNull();
  });

  it("builds a priced size catalogue whose ids match the instance size field", () => {
    const sizes = sizeOptionsFromShapes(
      [
        {
          shape: "VM.Standard.E4.Flex",
          isFlexible: true,
          ocpuOptions: { min: 1, max: 4 },
          memoryOptions: { defaultPerOcpuInGBs: 16, maxInGBs: 64 },
        },
        {
          shape: "VM.Standard.A1.Flex",
          isFlexible: true,
          ocpuOptions: { min: 1, max: 2 },
          memoryOptions: { defaultPerOcpuInGBs: 6 },
        },
        { shape: "VM.Standard2.1", ocpus: 1, memoryInGBs: 15 },
        { shape: "BM.Standard.E4.128", ocpus: 128, memoryInGBs: 2048 },
      ],
      FALLBACK_RATES,
    );
    expect(sizes.map((s) => s.id)).toEqual([
      "VM.Standard.E4.Flex/1/16",
      "VM.Standard.E4.Flex/2/32",
      "VM.Standard.E4.Flex/4/64",
      "VM.Standard.A1.Flex/1/6",
      "VM.Standard.A1.Flex/2/12",
      "VM.Standard2.1",
    ]);
    const e4 = sizes[0]!;
    // 1 OCPU × 744 h × $0.025 + 16 GB × 744 h × $0.0015
    expect(e4.priceMonthly).toBeCloseTo(18.6 + 17.856, 2);
    expect(e4.vcpus).toBe(2);
    expect(sizes[3]!.vcpus).toBe(1);
  });

  it("estimates an instance, a volume and an Always Free database", () => {
    const vm = estimateFor(FALLBACK_RATES, "instance", {
      size: "VM.Standard.E4.Flex/2/32",
      bootVolumeSizeGb: "50",
    });
    expect(vm!.lineItems.map((l) => l.label)).toEqual([
      "Compute (VM.Standard.E4.Flex)",
      "Memory",
      "Boot volume",
      "Boot volume performance",
    ]);
    const vol = estimateFor(FALLBACK_RATES, "block-volume", { sizeGb: "100", vpusPerGb: "0" });
    expect(vol!.monthlyAmount).toBeCloseTo(2.55, 2);
    expect(
      estimateFor(FALLBACK_RATES, "autonomous-database", { freeTier: "true", computeCount: "2" }),
    ).toBeNull();
    expect(
      estimateFor(FALLBACK_RATES, "oke-cluster", { clusterType: "ENHANCED_CLUSTER" })!
        .monthlyAmount,
    ).toBeCloseTo(74.4, 2);
  });
});

describe("status feed", () => {
  const item = (title: string, state: string, guid: string) => `<item>
    <title>${title}</title>
    <description>&lt;p>&lt;small>Oct&lt;var data-var='date'>04&lt;/var>&lt;var data-var='time'>09:12&lt;/var> UTC&lt;/small>&lt;br>&lt;strong>${state}&lt;/strong> - Engineers are working on it.&lt;/p></description>
    <pubDate>Sat, 04 Oct 2026 09:12:00 UTC</pubDate>
    <link>https://ocistatus.oraclecloud.com/#/incidents/${guid}</link>
    <guid>${guid}</guid>
  </item>`;

  it("keeps open incidents, maps the region name to its id, and drops resolved ones", () => {
    const rss = `<?xml version='1.0'?><rss><channel>
      ${item("Networking | US East (Ashburn) | ab12", "Identified", "ocid1.oraclecloudincident.oc1.phx.a")}
      ${item("Compute | Multiple Regions | cd34", "Investigating", "ocid1.oraclecloudincident.oc1.phx.b")}
      ${item("Object Storage | Germany Central (Frankfurt) | ef56", "Resolved", "ocid1.oraclecloudincident.oc1.phx.c")}
    </channel></rss>`;
    const incidents = parseStatusFeed(rss);
    expect(incidents).toHaveLength(2);
    expect(incidents[0]).toMatchObject({
      externalId: "ocid1.oraclecloudincident.oc1.phx.a",
      state: "identified",
      regions: ["us-ashburn-1"],
      services: ["Networking"],
    });
    expect(incidents[1]).toMatchObject({ state: "investigating", regions: [], providerWide: true });
  });
});

describe("terraform export", () => {
  it("maps a bucket with its namespace-qualified import id", () => {
    const bucket = makeResource("acct", "bucket", "eu-frankfurt-1/logs", "logs", {
      name: "logs",
      region: "eu-frankfurt-1",
      compartmentId: "ocid1.compartment.oc1..prod",
      namespace: "acmens",
      publicAccessType: "NoPublicAccess",
      storageTier: "Standard",
    });
    const out = ociTerraformExport.mapResource(bucket)!;
    expect(out.resource.type).toBe("oci_objectstorage_bucket");
    expect(out.resource.importId).toBe("n/acmens/b/logs");
  });

  it("maps a flex instance with its shape config and image", () => {
    const inst = makeResource("acct", "instance", "ocid1.instance.oc1.iad.a", "web", {
      name: "web",
      compartmentId: "ocid1.compartment.oc1..prod",
      availabilityDomain: "Uocm:US-ASHBURN-AD-1",
      size: "VM.Standard.E4.Flex/2/32",
      imageId: "ocid1.image.oc1.iad.x",
      subnetId: "ocid1.subnet.oc1.iad.s",
    });
    const out = ociTerraformExport.mapResource(inst)!;
    expect(out.resource.attributes["shape"]).toEqual({
      kind: "string",
      value: "VM.Standard.E4.Flex",
    });
    expect(out.resource.attributes["shape_config"]).toMatchObject({ kind: "block" });
  });

  it("leaves an instance without its image unmapped rather than guessing", () => {
    const inst = makeResource("acct", "instance", "ocid1.instance.oc1.iad.a", "web", {
      name: "web",
      compartmentId: "c",
      availabilityDomain: "ad",
      size: "VM.Standard2.1",
      subnetId: "s",
    });
    expect(ociTerraformExport.mapResource(inst)).toBeNull();
  });
});
