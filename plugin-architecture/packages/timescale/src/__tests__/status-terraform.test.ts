import { describe, expect, it } from "vitest";
import { createMockResource } from "@infrawrench/plugin-base/test-harness";
import { parseStatusFeed } from "../status-feed.js";
import { timescaleTerraformExport } from "../terraform.js";
import { RESOURCE_TYPES, T } from "../resource-types.js";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Tiger Data - Incident History</title>
<item>
  <title><![CDATA[Scheduled Maintenance 2026-10-05 - 2026-10-12]]></title>
  <description><![CDATA[[In Progress] <p>We will be performing maintenance in:</p>
<ul>
  <li>eu-central-1</li>
  <li>az-eastus2</li>
</ul>]]></description>
  <pubDate>Mon, 05 Oct 2026 06:00:00 -0700</pubDate>
  <link>https://status.tigerdata.com/incidents/aaa</link>
  <guid>https://status.tigerdata.com/incidents/aaa</guid>
</item>
<item>
  <title><![CDATA[Elevated connection errors]]></title>
  <description><![CDATA[[Investigating] We are looking into failed connections.

Impacted: Database - Data Plane and Core Availability]]></description>
  <pubDate>Tue, 06 Oct 2026 08:00:00 -0700</pubDate>
  <link>https://status.tigerdata.com/incidents/bbb</link>
  <guid>https://status.tigerdata.com/incidents/bbb</guid>
</item>
<item>
  <title><![CDATA[Console slow]]></title>
  <description><![CDATA[[Resolved] Fixed.

Impacted: Console &amp; API]]></description>
  <pubDate>Fri, 27 Mar 2026 09:03:22 -0700</pubDate>
  <link>https://status.tigerdata.com/incidents/ccc</link>
  <guid>https://status.tigerdata.com/incidents/ccc</guid>
</item>
</channel></rss>`;

describe("status feed", () => {
  const now = Date.parse("2026-10-06T18:00:00Z");
  const incidents = parseStatusFeed(RSS, now);

  it("drops resolved items older than two weeks", () => {
    expect(incidents.map((i) => i.externalId)).toEqual([
      "https://status.tigerdata.com/incidents/aaa",
      "https://status.tigerdata.com/incidents/bbb",
    ]);
  });

  it("reads maintenance regions from the body", () => {
    const m = incidents[0]!;
    expect(m.impact).toBe("maintenance");
    expect(m.state).toBe("investigating");
    expect(m.regions).toEqual(["eu-central-1", "az-eastus2"]);
    expect(m.providerWide).toBeUndefined();
  });

  it("scopes a data-plane incident to services", () => {
    const i = incidents[1]!;
    expect(i.impact).toBe("major");
    expect(i.resourceTypes).toEqual([T.service, T.replica]);
    expect(i.services).toEqual(["Database - Data Plane and Core Availability"]);
  });

  it("rejects a non-RSS body", () => {
    expect(() => parseStatusFeed("<html></html>")).toThrow();
  });
});

describe("terraform export", () => {
  const typeDef = (id: string) => RESOURCE_TYPES.find((t) => t.id === id)!;

  it("maps a service with its compute, HA and VPC", () => {
    const r = createMockResource("timescale", typeDef(T.service));
    r.fields = {
      name: "metrics",
      serviceId: "kd9w2xp4mz",
      region: "us-east-1",
      cpuMillis: 2000,
      memoryGb: 8,
      haReplicas: "1",
      syncReplicas: "0",
      environment: "PROD",
      poolerEnabled: true,
      vpcId: "1337",
    };
    const out = timescaleTerraformExport.mapResource(r)!;
    expect(out.resource.type).toBe("timescale_service");
    expect(out.resource.importId).toBe("kd9w2xp4mz");
    expect(out.resource.attributes["milli_cpu"]).toEqual({ kind: "number", value: 2000 });
    expect(out.resource.attributes["vpc_id"]).toEqual({ kind: "number", value: 1337 });
    expect(out.resource.attributes["sync_replicas"]).toBeUndefined();
  });

  it("imports a peering as peering_id,vpc_id", () => {
    const r = createMockResource("timescale", typeDef(T.peering));
    r.externalId = "proj/1337/42";
    r.fields = {
      vpcId: "1337",
      peerAccountId: "123456789012",
      peerVpcId: "vpc-1",
      peerRegion: "us-east-1",
    };
    expect(timescaleTerraformExport.mapResource(r)!.resource.importId).toBe("42,1337");
  });
});
