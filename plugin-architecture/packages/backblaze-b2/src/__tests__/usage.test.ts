import { describe, expect, it } from "vitest";
import { monthsBetween, parseCsv, parseUsageCsv, priceMonth, usageSeries } from "../usage.js";
import { parseStatusFeed } from "../status-feed.js";

const CSV = [
  "date,bucket_id,bucket_name,reporting_location,storage_byte_hours,stored_gb,downloaded_bytes,uploaded_gb,deleted_gb,api_txn_class_a,api_txn_class_b,api_txn_class_c,api_txn_class_d",
  // 1 TB stored all day; 5 TB downloaded; 3,000 Class D calls.
  `2026-09-01,b1,"photos,bucket",us-west,${1e12 * 24},1000,${5e12},2,0,10,20,30,3000`,
].join("\n");

describe("usage reports", () => {
  it("parses quoted CSV by header name", () => {
    expect(parseCsv('a,"b ""c""",d\r\n1,2,3')).toEqual([
      ["a", 'b "c"', "d"],
      ["1", "2", "3"],
    ]);
    const [row] = parseUsageCsv(CSV);
    expect(row).toMatchObject({
      bucketId: "b1",
      bucketName: "photos,bucket",
      storedGb: 1000,
      classD: 3000,
    });
  });

  it("prices storage, the download overage and Class D at list", () => {
    const rows = priceMonth(parseUsageCsv(CSV));
    const by = Object.fromEntries(rows.map((r) => [r.service, r.amount]));
    // (1e12*24 - 10e9*24) byte-hours / 1e12 / 720 * 6.95
    expect(by["Storage"]).toBeCloseTo(((1e12 - 10e9) * 24 * 6.95) / 1e12 / 720, 5);
    // 5 TB down, 3 TB free (3x average of 1 TB): 2,000 GB × $0.01
    expect(by["Download"]).toBeCloseTo(20, 5);
    // 500 calls over the free 2,500 at $0.004 / 10,000
    expect(by["API transactions"]).toBeCloseTo(0.0002, 6);
    expect(rows.every((r) => r.resourceId === "b1" && r.region === "us-west")).toBe(true);
  });

  it("builds daily series per bucket", () => {
    const series = usageSeries(parseUsageCsv(CSV), "b1");
    expect(series.find((s) => s.label === "Stored")!.points[0]!.value).toBe(1000);
    expect(usageSeries(parseUsageCsv(CSV), "other")[0]!.points).toHaveLength(0);
  });

  it("enumerates months", () => {
    expect(monthsBetween("2025-11-20", "2026-02-01")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

describe("status feed", () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Backblaze Status</title>
<item><title>Scheduled Maintenance: EU uploads</title><description>Some customers

Scheduled maintenance window: Thu, 01 Oct 2026 06:09:00 +0000 - Thu, 01 Oct 2026 18:09:00 +0000

Maintenance will impact:
- EU Central Region: Degraded</description><pubDate>Thu, 01 Oct 2026 06:11:10 +0000</pubDate></item>
<item><title>Elevated API errors</title><description>US West Region: Degraded. Investigating.</description><pubDate>Thu, 01 Oct 2026 10:00:00 +0000</pubDate></item>
</channel></rss>`;

  it("keeps maintenance inside its window and recent incidents", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const out = parseStatusFeed(feed, now);
    expect(out.map((i) => [i.impact, i.regions])).toEqual([
      ["maintenance", ["eu-central"]],
      ["minor", ["us-west"]],
    ]);
    expect(parseStatusFeed(feed, Date.parse("2026-10-03T00:00:00Z"))).toEqual([]);
  });

  it("rejects non-RSS bodies", () => {
    expect(() => parseStatusFeed("<html></html>")).toThrow();
  });
});
