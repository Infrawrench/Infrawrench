import { describe, expect, it } from "vitest";
import { createMockResource } from "@infrawrench/plugin-base/test-harness";
import { parsePrometheusText, prometheusSeries } from "../metrics.js";
import { parseStatusFeed } from "../status-feed.js";
import { plugin } from "../plugin.js";
import { redisCloudTerraformExport } from "../terraform.js";

describe("prometheusSeries", () => {
  it("picks one database's v1 gauges and converts units", () => {
    const samples = parsePrometheusText(
      [
        "# HELP bdb_total_req x",
        'bdb_instantaneous_ops_per_sec{cluster="c",bdb="51"} 1200',
        'bdb_instantaneous_ops_per_sec{cluster="c",bdb="52"} 9',
        'bdb_avg_latency{bdb="51"} 0.0005',
        'bdb_conns{bdb="51"} 14',
        'bdb_read_hits{bdb="51"} 90',
        'bdb_read_misses{bdb="51"} 10',
      ].join("\n"),
    );
    const series = prometheusSeries(samples, "51", 1000);
    const byLabel = Object.fromEntries(series.map((s) => [s.label, s.points[0]!.value]));
    expect(byLabel).toEqual({ "Ops/sec": 1200, Latency: 0.5, Connections: 14, "Hit ratio": 90 });
  });
});

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Redis</title>
<item><title>Update for incident &quot;Redis Cloud – API errors&quot;</title><link>https://status.redis.io/incidents/a</link>
<description>Fixed. Milestone is now 'resolved'. Previously milestone was 'investigating'</description><pubDate>Sat, 03 Oct 2026 13:39:48 +0000</pubDate></item>
<item><title>New incident: &quot;Redis Cloud – API errors&quot;</title><link>https://status.redis.io/incidents/a</link><pubDate>Sat, 03 Oct 2026 12:58:29 +0000</pubDate></item>
<item><title>New incident: &quot;Console slow&quot;</title><link>https://status.redis.io/incidents/b</link>
<description>Milestone is now 'investigating'.</description><pubDate>Sun, 04 Oct 2026 09:00:00 +0000</pubDate></item>
<item><title>New incident: &quot;Old&quot;</title><link>https://status.redis.io/incidents/c</link><pubDate>Mon, 01 Jun 2026 09:00:00 +0000</pubDate></item>
</channel></rss>`;

describe("parseStatusFeed", () => {
  it("groups updates by incident and reads the latest milestone", () => {
    const incidents = parseStatusFeed(FEED, Date.parse("2026-10-04T12:00:00Z"));
    expect(incidents).toHaveLength(2);
    const a = incidents.find((i) => i.externalId.endsWith("/a"))!;
    expect(a).toMatchObject({
      title: "Redis Cloud – API errors",
      state: "resolved",
      startedAt: "2026-10-03T12:58:29.000Z",
    });
    expect(incidents.find((i) => i.externalId.endsWith("/b"))!.state).toBe("investigating");
  });
});

describe("terraform export", () => {
  const type = (id: string) => plugin.resourceTypes.find((t) => t.id === id)!;

  it("maps an ACL role with its database assignments", () => {
    const role = createMockResource("redis-cloud", type("rc-acl-role"));
    role.fields["ruleSpec"] = JSON.stringify([{ ruleName: "Read-Only", databases: ["1206/51"] }]);
    const out = redisCloudTerraformExport.mapResource(role)!;
    expect(out.resource.type).toBe("rediscloud_acl_role");
    expect(JSON.stringify(out.resource.attributes)).toContain('"value":51');
  });

  it("maps a Pro database with an import id of subscription/database", () => {
    const db = createMockResource("redis-cloud", type("rc-database"));
    db.fields["plan"] = "Pro";
    db.fields["subscriptionId"] = "1206";
    db.externalId = "51";
    const out = redisCloudTerraformExport.mapResource(db)!;
    expect(out.resource.type).toBe("rediscloud_subscription_database");
    expect(out.resource.importId).toBe("1206/51");
  });

  it("keeps the ACL user password out of the document", () => {
    const user = createMockResource("redis-cloud", type("rc-acl-user"));
    const out = redisCloudTerraformExport.mapResource(user)!;
    expect(out.resource.attributes["password"]).toMatchObject({ kind: "ref" });
    expect(out.variables?.[0]?.sensitive).toBe(true);
  });
});
