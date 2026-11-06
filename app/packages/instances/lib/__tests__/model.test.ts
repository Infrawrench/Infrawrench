import { describe, expect, it } from "vitest";
import { decodeAttributes, decodeInstance } from "../decode";
import { describe as describeInstance } from "../describe";
import { gpuCount, specs } from "../attributes";
import { commitmentLabel, effectiveHourly, formatPrice, leaseMonths, termLabel } from "../format";
import { rebaseToUsd } from "../fx";
import { translatorFor } from "../i18n/server";
import { createLookupOptions, hashMessage } from "gt-i18n/internal";
import {
  buildModel,
  buildRegionData,
  distinguishingKeys,
  latestAttributes,
  relatives,
  spotSystem,
} from "../model";
import { headlineTerms, priceHistory } from "../series";
import { parseName, sizeRank } from "../names";
import { PLATFORMS, fullLabel, instancePath, platformAt } from "../platforms";
import { renderMarkdown } from "../markdown";
import { familiesOf } from "../catalog";
import { pagesSitemap, platformSitemap, sitemapIndex } from "../sitemap";
import { prefersMarkdown } from "../negotiate";
import { stepPaths } from "../step-path";
import { timeTicks } from "../time-ticks";
import { attributeTimelines, closestOffered, variantsAlong, withField } from "../selection";
import { file, spotFile } from "./fixture";

const decoded = decodeInstance(file);
const model = buildModel(decoded, PLATFORMS.ec2!, {
  asOf: 5000,
  family: [],
  related: [],
  fx: null,
});

describe("decodeInstance", () => {
  it("adds locations that only price rows name to the regions", () => {
    expect(decoded.regions).toEqual([
      { name: "US East (N. Virginia)", code: "us-east-1", type: "AWS Region" },
      { name: "EU (Ireland)", code: "eu-west-1", type: "AWS Region" },
      { name: "Local Zone X" },
    ]);
  });

  it("fills omitted prices with the base price and keeps removals", () => {
    expect(decoded.onDemand[0]).toEqual({ at: 1000, region: 0, variant: 0, hourly: 0.1 });
    expect(decoded.onDemand.at(-1)).toEqual({ at: 4000, region: 2, variant: 0, hourly: null });
  });

  it("reads a $0 on-demand price as not offered", () => {
    const zero = structuredClone(file);
    zero.instance[3].push([3000, 0, 1, 0]);
    expect(decodeInstance(zero).onDemand.at(-2)).toEqual({
      at: 3000,
      region: 0,
      variant: 1,
      hourly: null,
    });
  });

  it("sorts attribute changes and maps regional ones", () => {
    expect(decoded.attributes.slice(3)).toEqual([
      { at: 2000, key: "clockSpeed", value: "3.1 GHz", region: null },
      { at: 3000, key: "storage", value: "EBS only", region: 1 },
    ]);
  });

  it("leaves regional changes out when reading attributes alone", () => {
    expect(latestAttributes(decodeAttributes(file))).toEqual({
      vcpu: "2",
      memory: "8 GiB",
      clockSpeed: "3.1 GHz",
    });
  });
});

describe("buildModel", () => {
  it("keeps the current price of everything still offered", () => {
    expect(model.current).toEqual([
      [
        [0, 0.09],
        [1, 0.2],
        [2, 0.15],
      ],
      [[0, 0.11]],
      [],
    ]);
  });

  it("counts regions offering the instance over time", () => {
    expect(model.availability).toEqual([
      [1000, 2],
      [1500, 3],
      [4000, 2],
    ]);
  });

  it("opens on us-east-1 and the platform's preferred variant", () => {
    expect(model.defaultRegion).toBe(0);
    expect(model.defaultVariant).toBe(0);
  });

  it("carries one region's full history", () => {
    expect(buildRegionData(decoded, 0)).toEqual({
      region: 0,
      onDemand: {
        0: [
          [1000, 0.1],
          [2500, 0.09],
        ],
        1: [[1000, 0.2]],
        2: [[1000, 0.15]],
      },
      reserved: { "0:0": [[1000, 0.06, 0]], "0:1": [[1000, 0.03, 500]] },
    });
  });
});

describe("spot", () => {
  const spot = decodeInstance(spotFile);
  const withSpot = buildModel(decoded, PLATFORMS.ec2!, {
    asOf: 5000,
    family: [],
    related: [],
    fx: null,
    spot: { decoded: spot, asOf: 3600 },
  });

  it("has no spot prices without a spot instance", () => {
    expect(model.spot).toBeNull();
    expect(spotSystem(model, 0)).toBe(-1);
  });

  it("keeps the current spot price per region, by region code", () => {
    // ap-south-1 is not one of the EC2 instance's regions, so it is left out.
    expect(withSpot.spot).toEqual({
      systems: ["Linux", "Windows"],
      current: [
        [
          [0, 0.035],
          [1, 0.12],
        ],
        [],
        [],
      ],
      asOf: 3600,
    });
  });

  it("applies to shared tenancy only, by operating system", () => {
    expect(spotSystem(withSpot, 0)).toBe(0); // Linux, Shared
    expect(spotSystem(withSpot, 1)).toBe(1); // Windows, Shared
    expect(spotSystem(withSpot, 2)).toBe(-1); // Linux, Dedicated
  });

  it("carries the region's spot history and draws it with the others", () => {
    const data = buildRegionData(decoded, 0, spot);
    expect(data.spot).toEqual({
      0: [
        [3000, 0.04],
        [3600, 0.035],
      ],
      1: [[3000, 0.12]],
    });
    expect(buildRegionData(decoded, 1, spot).spot).toBeUndefined();
    expect(priceHistory(withSpot, data, 0, "standard|No Upfront").map((s) => s.id)).toEqual([
      "od",
      "1yr",
      "3yr",
      "spot",
    ]);
    expect(priceHistory(withSpot, data, 2, "standard|No Upfront").map((s) => s.id)).not.toContain(
      "spot",
    );
  });

  it("lists spot prices by region and by day in Markdown", () => {
    const md = renderMarkdown(withSpot, buildRegionData(decoded, 0, spot), {
      description: "D.",
      pageUrl: "https://instances.infrawrench.com/aws/ec2/m5.large",
      tr: translatorFor("en", {}),
    });
    expect(md).toContain("## Spot price by region");
    expect(md).toContain("| US East (N. Virginia) | us-east-1 | $0.035 | 61% |");
    expect(md).toContain("| 1970-01-01 | $0.035 |");
    // Spot stays out of the on-demand and reserved history table.
    expect(md).toContain("| Date | On demand | 1-year reserved | 3-year reserved |");
  });
});

describe("distinguishingKeys", () => {
  it("hides fields the earlier ones decide", () => {
    expect(
      distinguishingKeys(
        file.variants.map((v) => v.map(String)),
        2,
      ),
    ).toEqual([0, 1]);
    expect(
      distinguishingKeys(
        [
          ["Linux", "Shared", "14"],
          ["Windows", "Shared", "12"],
        ],
        3,
      ),
    ).toEqual([0]);
  });
});

describe("selection", () => {
  it("switches one field and keeps the rest", () => {
    expect(withField(model, 0, 0, "Windows", 0)).toBe(1);
    expect(withField(model, 1, 1, "Dedicated", 0)).toBe(2);
  });

  it("falls back to an offered variant when the region lacks the selected one", () => {
    expect(closestOffered(model, 2, 1)).toBe(0);
    expect(closestOffered(model, 2, 0)).toBe(2);
  });

  it("lines up the variants that differ in one field", () => {
    expect(variantsAlong(model, 0, 0, 0)).toEqual([0, 1]);
    expect(variantsAlong(model, 0, 1, 0)).toEqual([0, 2]);
  });

  it("applies a region's own changes on top of the global ones", () => {
    const ireland = attributeTimelines(decoded.attributes, 1);
    expect(ireland.get("storage")).toEqual([{ at: 3000, value: "EBS only", regional: true }]);
    expect(ireland.get("clockSpeed")).toEqual([
      { at: 1000, value: "2.5 GHz", regional: false },
      { at: 2000, value: "3.1 GHz", regional: false },
    ]);
    expect(attributeTimelines(decoded.attributes, 0).has("storage")).toBe(false);
  });

  it("keeps a regional value after a newer global change", () => {
    const changes = [
      { at: 1, key: "k", value: "a", region: null },
      { at: 2, key: "k", value: "regional", region: 0 },
      { at: 3, key: "k", value: "b", region: null },
    ];
    expect(
      attributeTimelines(changes, 0)
        .get("k")!
        .map((s) => s.value),
    ).toEqual(["a", "regional"]);
    expect(
      attributeTimelines(changes, 1)
        .get("k")!
        .map((s) => s.value),
    ).toEqual(["a", "b"]);
  });
});

describe("names", () => {
  it.each([
    ["m5.large", "m5", "large"],
    ["db.r5.large", "r5", "large"],
    ["r6g.large.search", "r6g", "large"],
    ["ml.c6g.4xlarge-Hosting", "c6g", "4xlarge"],
    ["c8i-flex.16xlarge", "c8i-flex", "16xlarge"],
    ["db.r8i.metal-48xl", "r8i", "metal-48xl"],
    ["db.r5b.8xlarge.tpc2.mem3x", "r5b", "8xlarge"],
    ["m5.host", "m5", "host"],
  ])("parses %s", (name, family, size) => {
    expect(parseName(name)).toMatchObject({ family, size });
  });

  it("orders sizes", () => {
    const sizes = ["metal", "2xlarge", "large", "xlarge", "nano", "48xlarge", "host"];
    expect(sizes.sort((a, b) => sizeRank(a) - sizeRank(b))).toEqual([
      "nano",
      "large",
      "xlarge",
      "2xlarge",
      "48xlarge",
      "metal",
      "host",
    ]);
  });

  it("finds the family and the same size in sibling families", () => {
    const names = [
      "m5.xlarge",
      "m5.large",
      "m5a.large",
      "m5d.2xlarge",
      "m6i.large",
      "ml.m5.large-Hosting",
    ];
    expect(relatives("m5.large", names)).toEqual({
      family: ["m5.large", "m5.xlarge"],
      related: [
        { family: "m5a", name: "m5a.large" },
        { family: "m5d", name: "m5d.2xlarge" },
      ],
    });
  });
});

describe("format", () => {
  it("spreads the upfront payment over the lease", () => {
    expect(
      effectiveHourly(
        { lease: "3yr", offeringClass: "standard", purchaseOption: "Partial Upfront" },
        0.03,
        262.8,
      ),
    ).toBeCloseTo(0.04);
  });

  it("scales prices to the duration", () => {
    expect(formatPrice(0.1, "monthly")).toBe("$73.00");
    expect(formatPrice(null, "hourly")).toBeNull();
  });

  it("converts to the chosen currency", () => {
    expect(formatPrice(0.1, "monthly", { code: "EUR", rate: 0.5 })).toBe("€36.50");
  });
});

describe("rebaseToUsd", () => {
  it("turns per-EUR rates into per-USD ones", () => {
    const perUsd = rebaseToUsd({ USD: "1.25", GBP: "0.8" })!;
    expect(perUsd.USD).toBe(1);
    expect(perUsd.EUR).toBeCloseTo(0.8);
    expect(perUsd.GBP).toBeCloseTo(0.64);
    expect(rebaseToUsd({ GBP: "0.8" })).toBeNull();
  });
});

describe("describe", () => {
  const en = translatorFor("en", {});

  it("summarises specs and the opening price", () => {
    expect(describeInstance(model, en, "en")).toBe(
      "m5.large is an instance type on AWS EC2 with 2 vCPUs and 8 GiB of memory. It costs $0.09 per hour on demand in US East (N. Virginia).",
    );
  });

  it("uses the catalog, and the locale's list and number formats", () => {
    const source = "{name} is an instance type on {platform} with {specs}.";
    const hash = hashMessage(source, createLookupOptions("fr", {}, "ICU"));
    const fr = translatorFor("fr", {
      [hash]: "{name} est une instance {platform} avec {specs}.",
    });
    // French money uses a (narrow) no-break space before the currency.
    expect(describeInstance(model, fr, "fr").replace(/[\u00a0\u202f]/g, " ")).toBe(
      "m5.large est une instance AWS EC2 avec 2 vCPUs et 8 GiB of memory. It costs 0,09 $US per hour on demand in US East (N. Virginia).",
    );
  });
});

describe("timeTicks", () => {
  const at = (y: number, m: number) => Date.UTC(y, m, 1) / 1000;
  it("labels years over long spans and months over short ones", () => {
    expect(timeTicks(at(2018, 5), at(2026, 9)).map((t) => t.label)).toEqual([
      "2019",
      "2021",
      "2023",
      "2025",
    ]);
    expect(timeTicks(at(2026, 7), at(2026, 9) + 86400).map((t) => t.label)).toEqual([
      "Sep 26",
      "Oct 26",
    ]);
  });
});

describe("stepPaths", () => {
  const id = (n: number) => n;
  it("bridges a gap with a dashed connector and keeps one dot per new price", () => {
    const out = stepPaths(
      [
        [0, 10],
        [10, null],
        [20, 10],
        [30, null],
        [40, 8],
      ],
      50,
      id,
      id,
    );
    expect(out.solid).toBe("M0.0,10.0H10.0M20.0,10.0H30.0M40.0,8.0H50.0");
    expect(out.dashed).toBe("M10.0,10.0H20.0V10.0M30.0,10.0H40.0V8.0");
    expect(out.dots).toEqual([
      { at: 0, value: 10 },
      { at: 40, value: 8 },
    ]);
    expect(out.contiguous).toBe(false);
  });

  it("ends the line at a gap nothing closes", () => {
    const out = stepPaths(
      [
        [0, 10],
        [10, 12],
        [20, null],
      ],
      50,
      id,
      id,
    );
    expect(out.solid).toBe("M0.0,10.0H10.0L10.0,12.0H20.0");
    expect(out.dashed).toBe("");
    expect(out.contiguous).toBe(true);
  });
});

describe("prefersMarkdown", () => {
  it.each([
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/html, text/markdown;q=0.5", false],
    ["text/html,application/xhtml+xml,*/*;q=0.8", false],
    ["*/*", false],
    [null, false],
  ])("%s", (accept, expected) => {
    expect(prefersMarkdown(accept)).toBe(expected);
  });
});

describe("renderMarkdown", () => {
  const md = renderMarkdown(model, buildRegionData(decoded, 0), {
    description: "D.",
    pageUrl: "https://instances.infrawrench.com/aws/ec2/m5.large",
    tr: translatorFor("en", {}),
  });

  it("has the specs with their earlier values", () => {
    expect(md).toContain("# m5.large");
    expect(md).toContain("| Clock speed | `clockSpeed` | 3.1 GHz | 1970-01-01: 2.5 GHz |");
  });

  it("lists prices by region and the region's history", () => {
    expect(md).toContain("| US East (N. Virginia) | us-east-1 | $0.09 | $65.7 |");
    expect(md).toContain("| EU (Ireland) | eu-west-1 | $0.11 | $80.3 |");
    expect(md).toContain("| 1970-01-01 | $0.1 | $0.06 | $0.0490259 |");
  });
});

describe("sitemaps", () => {
  it("lists every platform sitemap", () => {
    expect(sitemapIndex(["ec2", "rds"])).toContain(
      "<sitemap><loc>https://instances.infrawrench.com/sitemaps/rds.xml</loc></sitemap>",
    );
  });

  it("gives each language its own URL with all the alternates", () => {
    const xml = platformSitemap("ec2", ["m5.large"]);
    // The listing and the instance, in nine languages each.
    expect(xml.match(/<url>/g)).toHaveLength(18);
    expect(xml).toContain("<loc>https://instances.infrawrench.com/fr/aws/ec2</loc>");
    expect(xml).toContain("<loc>https://instances.infrawrench.com/aws/ec2/m5.large</loc>");
    expect(xml).toContain("<loc>https://instances.infrawrench.com/ja/aws/ec2/m5.large</loc>");
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="x-default" href="https://instances.infrawrench.com/aws/ec2/m5.large"/>',
    );
    expect(xml.match(/hreflang="fr"/g)).toHaveLength(18);
  });
});

describe("familiesOf", () => {
  it("groups by family, in natural order, smallest size first", () => {
    const families = familiesOf([
      "m5.xlarge",
      "m10.large",
      "m5.large",
      "c5a.large",
      "c5.metal",
      "c5.large",
      "db.r5b.8xlarge.tpc2.mem3x",
      "ml.c6g.large-Hosting",
      "weird",
    ]);
    expect(families.map((f) => [f.label, f.instances])).toEqual([
      ["c5", ["c5.large", "c5.metal"]],
      ["c5a", ["c5a.large"]],
      ["db.r5b (tpc2.mem3x)", ["db.r5b.8xlarge.tpc2.mem3x"]],
      ["m5", ["m5.large", "m5.xlarge"]],
      ["m10", ["m10.large"]],
      ["ml.c6g (Hosting)", ["ml.c6g.large-Hosting"]],
      ["", ["weird"]],
    ]);
  });
});

describe("pages sitemap", () => {
  it("lists the index in every language", () => {
    const xml = pagesSitemap();
    expect(xml).toContain("<loc>https://instances.infrawrench.com/</loc>");
    expect(xml).toContain("<loc>https://instances.infrawrench.com/ja</loc>");
  });
});

describe("other clouds", () => {
  const en = translatorFor("en", {});

  it("puts each platform's pages under its cloud", () => {
    expect(instancePath("ec2", "m5.large")).toBe("/aws/ec2/m5.large");
    expect(instancePath("alibaba", "ecs.g7.large")).toBe("/alibaba/ecs/ecs.g7.large");
    expect(instancePath("runpod", "NVIDIA H100 80GB HBM3")).toBe(
      "/runpod/pods/NVIDIA%20H100%2080GB%20HBM3",
    );
    expect(platformAt("alibaba", "ecs")).toBe("alibaba");
    expect(platformAt("aws", "ecs")).toBeUndefined();
    expect(fullLabel("runpod")).toBe("RunPod Pods");
  });

  it("lists every cloud in the pages sitemap and encodes RunPod's names", () => {
    expect(pagesSitemap()).toContain("<loc>https://instances.infrawrench.com/runpod</loc>");
    expect(platformSitemap("runpod", ["NVIDIA L4"])).toContain(
      "<loc>https://instances.infrawrench.com/runpod/pods/NVIDIA%20L4</loc>",
    );
  });

  it("parses RunPod CPU pods by flavor and vCPUs, and leaves GPUs alone", () => {
    expect(parseName("cpu3c-2-4")).toMatchObject({ family: "cpu3c", size: "2-4" });
    expect(parseName("NVIDIA H100 80GB HBM3")).toBeNull();
    expect(relatives("cpu3c-4-8", ["cpu3c-16-32", "cpu3c-2-4", "cpu3c-4-8", "cpu3g-4-16"])).toEqual(
      {
        family: ["cpu3c-2-4", "cpu3c-4-8", "cpu3c-16-32"],
        related: [{ family: "cpu3g", name: "cpu3g-4-16" }],
      },
    );
    expect(familiesOf(["cpu3c-8-16", "cpu3c-2-4", "NVIDIA L4"]).map((f) => f.label)).toEqual([
      "cpu3c",
      "",
    ]);
  });

  it("spreads month and multi-year leases over their length", () => {
    const sub = (lease: string) => ({
      lease,
      offeringClass: "Subscription",
      purchaseOption: "All Upfront",
    });
    expect(leaseMonths("3mo")).toBe(3);
    expect(leaseMonths("5yr")).toBe(60);
    expect(effectiveHourly(sub("1mo"), 0, 73)).toBeCloseTo(0.1);
    expect(effectiveHourly(sub("2yr"), 0, 2 * 8760)).toBeCloseTo(1);
  });

  it("headlines at most three terms, shortest first", () => {
    const terms = ["5yr", "1yr", "1mo", "2yr", "3yr", "4yr"].map((lease) => ({
      lease,
      offeringClass: "Subscription",
      purchaseOption: "All Upfront",
    }));
    const picked = headlineTerms({ terms }, "Subscription|All Upfront");
    expect(picked.map((i) => terms[i]!.lease)).toEqual(["1mo", "1yr", "3yr"]);
    const plans = ["6mo", "3mo"].map((lease) => ({
      lease,
      offeringClass: "Savings Plan",
      purchaseOption: "All Upfront",
    }));
    expect(headlineTerms({ terms: plans }, "Savings Plan|All Upfront")).toEqual([1, 0]);
  });

  it("names each kind of commitment", () => {
    const term = (offeringClass: string, lease: string, purchaseOption = "All Upfront") => ({
      lease,
      offeringClass,
      purchaseOption,
    });
    expect(commitmentLabel(term("standard", "1yr"), en)).toBe("1-year reserved");
    expect(commitmentLabel(term("Savings Plan", "3mo"), en)).toBe("Savings plan, 3 months");
    expect(commitmentLabel(term("Subscription", "1mo"), en)).toBe("Subscription, 1 month");
    expect(termLabel(term("Reserved Instance", "1yr", "No Upfront"), en)).toBe(
      "Reserved instance, No Upfront",
    );
  });

  it("reads Alibaba's and RunPod's specs", () => {
    expect(specs({ CpuCoreCount: "2", MemorySize: "8.0" })).toEqual({ vcpu: "2", memory: "8 GiB" });
    expect(specs({ vcpu: "2", memoryInGb: "4", productFamily: "CPU", priceUnit: "Hour" })).toEqual({
      vcpu: "2",
      memory: "4 GB",
    });
    // A GPU type's memoryInGb is the GPU's own.
    expect(specs({ memoryInGb: "80", productFamily: "GPU", priceUnit: "GPU-Hour" })).toEqual({});
  });

  it("puts Hetzner, OVHcloud, Oracle and IBM under their own clouds", () => {
    expect(instancePath("hetzner", "cx23")).toBe("/hetzner/cloud/cx23");
    expect(instancePath("hetznerauction", "3107671")).toBe("/hetzner/auction/3107671");
    expect(instancePath("ovh", "b3-8")).toBe("/ovh/cloud/b3-8");
    expect(instancePath("ovheco", "24sys01")).toBe("/ovh/eco/24sys01");
    expect(instancePath("oracle", "BM.GPU.H100.8")).toBe("/oracle/compute/BM.GPU.H100.8");
    expect(instancePath("ibm", "bx3d-2x10")).toBe("/ibm/vpc/bx3d-2x10");
    expect(platformAt("ovh", "eco")).toBe("ovheco");
    expect(platformAt("hetzner", "auction")).toBe("hetznerauction");
    expect(fullLabel("ibm")).toBe("IBM Cloud Virtual Servers for VPC");
  });

  it("parses their names", () => {
    expect(parseName("cx23")).toMatchObject({ family: "cx", size: "23" });
    expect(parseName("b3-8")).toMatchObject({ family: "b3", size: "8" });
    expect(parseName("24sys01")).toMatchObject({ family: "24sys", size: "01" });
    expect(parseName("25sk60b")).toMatchObject({ family: "25sk", size: "60" });
    expect(parseName("24skgame01-apac")).toMatchObject({ family: "24skgame", size: "01" });
    expect(parseName("eg-120")).toMatchObject({ family: "eg", size: "120" });
    expect(parseName("vx3d-22x352-spl")).toMatchObject({ family: "vx3d", size: "22x352-spl" });
    // RunPod's CPU pods keep their own scheme.
    expect(parseName("cpu3c-2-4")).toMatchObject({ family: "cpu3c", size: "2-4" });
    expect(parseName("VM.Standard.E5.Flex-2-16")).toMatchObject({
      family: "VM.Standard.E5.Flex",
      size: "2-16",
    });
    expect(parseName("BM.GPU.H100.8")).toMatchObject({ family: "BM.GPU.H100", size: "8" });
    expect(parseName("bx3d-2x10")).toMatchObject({ family: "bx3d", size: "2x10" });
    expect(parseName("gx3-16x80x1l4")).toMatchObject({ family: "gx3", size: "16x80x1l4" });
    // A listing id has no family or size.
    expect(parseName("3107671")).toBeNull();
    expect(sizeRank("2x10")).toBeLessThan(sizeRank("16x80x1l4"));
    expect(sizeRank("2-16")).toBeLessThan(sizeRank("8-64"));
  });

  it("counts an eco server's threads and an Oracle shape's OCPUs as vCPUs", () => {
    expect(specs({ "cpu.cores": "6", "cpu.threads": "12" }).vcpu).toBe("12");
    expect(specs({ ocpus: "2", shape: "VM.Standard.E5.Flex" }).vcpu).toBe("4");
    expect(specs({ ocpus: "4", shape: "VM.Standard.A1.Flex" }).vcpu).toBe("4");
    expect(specs({ "cpu.cores": "8" }).vcpu).toBe("8");
  });

  it("makes a monthly rental's rent its main price", () => {
    // [string table]: an OVHcloud eco server, with no on-demand rows.
    const table = [
      "gra",
      "regionCode",
      "ram-32g",
      "softraid",
      "",
      "1mo",
      "Rental",
      "All Upfront",
      "1yr",
      "Prepaid",
      "range",
      "soyoustart",
      "ram-64g",
    ];
    const eco = decodeInstance({
      compression_table: table,
      platform: "ovheco",
      offer: "OVHEco",
      name: "24sys01",
      variant_keys: ["memory", "storage", "systemStorage"],
      regions: [[0, [[1, 0]]]],
      variants: [
        [2, 3, 4],
        [12, 3, 4],
      ],
      reserved_terms: [
        [8, 9, 7],
        [5, 6, 7],
      ],
      instance: [
        [[10, 11]],
        [],
        0,
        [],
        [
          [1000, 0, 0, 1, 0, 73],
          [1000, 0, 1, 1, 0, 146],
          [1000, 0, 0, 0, 0, 800],
          [2000, 0, 0, 1, 0, 80.3],
        ],
        1000,
        null,
      ],
    });
    expect(eco.billedMonthly).toBe(true);
    // The rent isn't a commitment any more, and the other term has followed its index.
    expect(eco.terms).toEqual([
      { lease: "1yr", offeringClass: "Prepaid", purchaseOption: "All Upfront" },
    ]);
    expect(eco.reserved).toEqual([
      { at: 1000, region: 0, variant: 0, term: 0, hourly: 0, upfront: 800 },
    ]);
    expect(eco.onDemand.map((r) => [r.at, r.variant, r.hourly])).toEqual([
      [1000, 0, 0.1],
      [1000, 1, 0.2],
      [2000, 0, 0.11],
    ]);

    const m = buildModel(eco, PLATFORMS.ovheco!, { asOf: 3000, family: [], related: [], fx: null });
    expect(m.billedMonthly).toBe(true);
    // Both configurations can be picked, because each has a price.
    expect(m.current[0]).toEqual([
      [0, 0.11],
      [1, 0.2],
    ]);
    expect(m.shownKeys).toEqual([0]);
    const money = translatorFor("en", {});
    expect(priceHistory(m, buildRegionData(eco, 0), 0, "Prepaid|All Upfront")[0]!.label).toBe(
      "Monthly rent",
    );
    expect(describeInstance(m, money, "en")).toContain("rents for $80.30 a month in gra");
  });

  it("leaves an instance with on-demand prices and a monthly term alone", () => {
    // Hetzner's monthly cap is a term, and its hourly price is the real one.
    const hetzner = decodeInstance({
      compression_table: ["fsn1", "regionCode", "IPv6 only", "1mo", "Monthly Cap", "Postpaid"],
      platform: "hetzner",
      offer: "HetznerCloud",
      name: "cx23",
      variant_keys: ["ipv4"],
      regions: [[0, [[1, 0]]]],
      variants: [[2]],
      reserved_terms: [[3, 4, 5]],
      instance: [[], [], 0.0104, [[1000, 0, 0]], [[1000, 0, 0, 0, 0, 6.49]], 1000, null],
    });
    expect(hetzner.billedMonthly).toBe(false);
    expect(hetzner.onDemand[0]!.hourly).toBe(0.0104);
    expect(hetzner.reserved).toHaveLength(1);
  });

  it("puts Azure and Google Cloud under their own clouds", () => {
    expect(instancePath("azure", "Standard_D2s_v3")).toBe("/azure/vms/Standard_D2s_v3");
    expect(instancePath("gcp", "n2-standard-2")).toBe("/gcp/compute/n2-standard-2");
    expect(platformAt("gcp", "compute")).toBe("gcp");
    expect(fullLabel("azure")).toBe("Azure Virtual Machines");
    expect(fullLabel("gcp")).toBe("Google Cloud Compute Engine");
  });

  it("parses Azure sizes by series and vCPUs", () => {
    expect(parseName("Standard_D2s_v3")).toMatchObject({ family: "Dsv3", size: "2" });
    expect(parseName("Standard_E64-16as_v6")).toMatchObject({ family: "Easv6", size: "64-16" });
    expect(parseName("Standard_NC24ads_A100_v4")).toMatchObject({
      family: "NCads_A100_v4",
      size: "24",
    });
    expect(parseName("Standard_B1ls")).toMatchObject({ family: "Bls", size: "1" });
    expect(parseName("SPOT_Plus_Usage")).toBeNull();
    expect(
      relatives("Standard_D4s_v5", [
        "Standard_D2s_v5",
        "Standard_D16s_v5",
        "Standard_D4s_v5",
        "Standard_D4ds_v5",
        "Standard_D8as_v5",
        "Standard_D4s_v3",
      ]),
    ).toEqual({
      family: ["Standard_D2s_v5", "Standard_D4s_v5", "Standard_D16s_v5"],
      related: [
        { family: "Dasv5", name: "Standard_D8as_v5" },
        { family: "Ddsv5", name: "Standard_D4ds_v5" },
      ],
    });
    expect(
      familiesOf(["Standard_D2_v2_Promo", "Standard_D2s_v3", "Standard_D16s_v3"]).map((f) => [
        f.label,
        f.instances,
      ]),
    ).toEqual([
      ["Dsv3", ["Standard_D2s_v3", "Standard_D16s_v3"]],
      ["Dv2 (Promo)", ["Standard_D2_v2_Promo"]],
    ]);
  });

  it("parses Google Cloud machine types by series, type and vCPUs", () => {
    expect(parseName("n2-standard-2")).toMatchObject({ family: "n2-standard", size: "2" });
    expect(parseName("a2-highgpu-1g")).toMatchObject({ family: "a2-highgpu", size: "1g" });
    expect(parseName("e2-micro")).toMatchObject({ family: "e2", size: "micro" });
    expect(parseName("m2-ultramem2x-96")).toMatchObject({ family: "m2-ultramem2x", size: "96" });
    expect(
      familiesOf(["c3-standard-4-lssd", "c3-standard-88", "c3-standard-8"]).map((f) => [
        f.label,
        f.instances,
      ]),
    ).toEqual([
      ["c3-standard", ["c3-standard-8", "c3-standard-88"]],
      ["c3-standard (lssd)", ["c3-standard-4-lssd"]],
    ]);
    expect(
      relatives("n2-standard-4", [
        "n2-standard-2",
        "n2-standard-4",
        "n2-highmem-4",
        "n2d-standard-8",
      ]).related,
    ).toEqual([
      { family: "n2-highmem", name: "n2-highmem-4" },
      { family: "n2d-standard", name: "n2d-standard-8" },
    ]);
    // The other clouds' names are not mistaken for these.
    expect(parseName("cpu3c-2-4")).toMatchObject({ family: "cpu3c" });
    expect(parseName("c8i-flex.16xlarge")).toMatchObject({ family: "c8i-flex" });
  });

  it("reads Azure's and Google Cloud's specs", () => {
    expect(specs({ cores: "2", ram: "8.0" })).toEqual({ vcpu: "2", memory: "8 GiB" });
    expect(specs({ guestCpus: "12", memoryMb: "87040" })).toEqual({
      vcpu: "12",
      memory: "85 GiB",
    });
    expect(gpuCount({ gpu: "8x H100" })).toBe(8);
    expect(gpuCount({ acceleratorCount: "2" })).toBe(2);
    expect(gpuCount({})).toBe(0);
  });

  it("names Google Cloud's commitments", () => {
    const cud = (lease: string) => ({
      lease,
      offeringClass: "Committed Use",
      purchaseOption: "No Upfront",
    });
    expect(commitmentLabel(cud("1yr"), en)).toBe("1-year commitment");
    expect(termLabel(cud("3yr"), en)).toBe("Committed use discount");
  });

  it("lets a region's value replace the global one listed at the same moment", () => {
    const zones = attributeTimelines(
      [
        { at: 100, key: "zones", value: "asia-east1-c", region: null },
        { at: 100, key: "zones", value: "us-central1-a,us-central1-b", region: 1 },
        { at: 200, key: "zones", value: "us-central1-a", region: 1 },
      ],
      1,
    ).get("zones");
    expect(zones).toEqual([
      { at: 100, value: "us-central1-a,us-central1-b", regional: true },
      { at: 200, value: "us-central1-a", regional: true },
    ]);
  });

  it("names Google Cloud's regions, which its bundle gives by code alone", () => {
    const gcp = decodeInstance({
      compression_table: [
        "us-central1",
        "regionCode",
        "locationType",
        "Google Cloud Region",
        "Standard",
      ],
      platform: "gcp",
      offer: "GCPCompute",
      name: "n2-standard-2",
      variant_keys: ["provisioningModel"],
      regions: [
        [
          0,
          [
            [1, 0],
            [2, 3],
          ],
        ],
      ],
      variants: [[4]],
      reserved_terms: [],
      instance: [[], [], 0.1, [[1700000000, 0, 0]], [], 1700000000, null],
    });
    expect(gcp.regions[0]).toEqual({
      name: "Council Bluffs, Iowa",
      code: "us-central1",
      type: "Google Cloud Region",
    });
  });
});
