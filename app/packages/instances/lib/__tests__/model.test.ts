import { describe, expect, it } from "vitest";
import { decodeAttributes, decodeInstance } from "../decode";
import { describe as describeInstance } from "../describe";
import { effectiveHourly, formatPrice } from "../format";
import { rebaseToUsd } from "../fx";
import { translatorFor } from "../i18n/server";
import { createLookupOptions, hashMessage } from "gt-i18n/internal";
import {
  buildModel,
  buildRegionData,
  distinguishingKeys,
  latestAttributes,
  relatives,
} from "../model";
import { parseName, sizeRank } from "../names";
import { PLATFORMS } from "../platforms";
import { renderMarkdown } from "../markdown";
import { familiesOf } from "../catalog";
import { pagesSitemap, platformSitemap, sitemapIndex } from "../sitemap";
import { prefersMarkdown } from "../negotiate";
import { stepPaths } from "../step-path";
import { timeTicks } from "../time-ticks";
import { attributeTimelines, closestOffered, variantsAlong, withField } from "../selection";
import { file } from "./fixture";

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
      "m5.large is an AWS EC2 instance with 2 vCPUs and 8 GiB of memory. It costs $0.09 per hour on demand in US East (N. Virginia).",
    );
  });

  it("uses the catalog, and the locale's list and number formats", () => {
    const source = "{name} is an AWS {platform} instance with {specs}.";
    const hash = hashMessage(source, createLookupOptions("fr", {}, "ICU"));
    const fr = translatorFor("fr", {
      [hash]: "{name} est une instance AWS {platform} avec {specs}.",
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
    // The listing and the instance, in six languages each.
    expect(xml.match(/<url>/g)).toHaveLength(12);
    expect(xml).toContain("<loc>https://instances.infrawrench.com/fr/aws/ec2</loc>");
    expect(xml).toContain("<loc>https://instances.infrawrench.com/aws/ec2/m5.large</loc>");
    expect(xml).toContain("<loc>https://instances.infrawrench.com/ja/aws/ec2/m5.large</loc>");
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="x-default" href="https://instances.infrawrench.com/aws/ec2/m5.large"/>',
    );
    expect(xml.match(/hreflang="fr"/g)).toHaveLength(12);
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
