import { describe, expect, it } from "vitest";
import { parseStatusFeedXml, parseStatuspageIncidents, stripStatusHtml } from "../status-feed.js";

const statuspageBody = JSON.stringify({
  incidents: [
    {
      id: "abc123",
      name: "Elevated Droplet create errors in NYC3",
      status: "identified",
      impact: "major",
      shortlink: "https://stspg.io/abc123",
      created_at: "2026-07-31T10:00:00Z",
      updated_at: "2026-07-31T11:00:00Z",
      resolved_at: null,
      incident_updates: [
        {
          body: "<p>We have identified the cause &amp; are rolling out a fix.</p>",
          created_at: "2026-07-31T11:00:00Z",
        },
        { body: "Investigating.", created_at: "2026-07-31T10:00:00Z" },
      ],
      components: [{ name: "NYC3" }, { name: "Droplets" }, { name: "Support portal" }],
    },
    {
      id: "def456",
      name: "Support portal slowness",
      status: "investigating",
      impact: "minor",
      created_at: "2026-07-31T09:00:00Z",
      incident_updates: [],
      components: [{ name: "Support portal" }],
    },
    {
      id: "ghi789",
      name: "Global API degradation",
      status: "monitoring",
      impact: "critical",
      created_at: "2026-07-31T08:00:00Z",
      incident_updates: [],
      components: [],
    },
  ],
});

describe("parseStatuspageIncidents", () => {
  const mapComponent = (name: string) => {
    if (name === "NYC3") return { regions: ["nyc3"] };
    if (name === "Droplets") return { services: ["Droplets"] };
    if (name === "Support portal") return null;
    return { providerWide: true };
  };

  it("maps components onto regions/services and strips update HTML", () => {
    const incidents = parseStatuspageIncidents(statuspageBody, { mapComponent });
    const nyc = incidents.find((i) => i.externalId === "abc123");
    expect(nyc).toBeDefined();
    expect(nyc?.regions).toEqual(["nyc3"]);
    expect(nyc?.services).toEqual(["Droplets"]);
    expect(nyc?.state).toBe("identified");
    expect(nyc?.impact).toBe("major");
    expect(nyc?.lastUpdateText).toBe("We have identified the cause & are rolling out a fix.");
    expect(nyc?.providerWide).toBeUndefined();
  });

  it("drops incidents whose only components are deliberately ignored", () => {
    const incidents = parseStatuspageIncidents(statuspageBody, { mapComponent });
    expect(incidents.find((i) => i.externalId === "def456")).toBeUndefined();
  });

  it("keeps component-less incidents as provider-wide", () => {
    const incidents = parseStatuspageIncidents(statuspageBody, { mapComponent });
    const global = incidents.find((i) => i.externalId === "ghi789");
    expect(global?.providerWide).toBe(true);
    expect(global?.impact).toBe("critical");
    expect(global?.state).toBe("monitoring");
  });

  it("normalizes maintenance statuses to the maintenance impact", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "m1",
          name: "Scheduled network maintenance",
          status: "in_progress",
          impact: "none",
          created_at: "2026-07-31T00:00:00Z",
          components: [{ name: "NYC3" }],
        },
      ],
    });
    const incidents = parseStatuspageIncidents(body, { mapComponent });
    expect(incidents[0]?.impact).toBe("maintenance");
    expect(incidents[0]?.state).toBe("investigating");
  });

  it("throws on bodies without an incidents array so the host can log the failure", () => {
    expect(() => parseStatuspageIncidents("{}", { mapComponent })).toThrow(/incidents/);
    expect(() => parseStatuspageIncidents("<html>", { mapComponent })).toThrow();
  });
});

describe("parseStatusFeedXml", () => {
  it("extracts RSS 2.0 items with CDATA titles", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title><![CDATA[Service is operating normally: [RESOLVED] Increased error rates]]></title>
        <link>https://status.example.com/#item1</link>
        <guid>https://status.example.com/#item1</guid>
        <pubDate>Fri, 31 Jul 2026 10:00:00 GMT</pubDate>
        <description>&lt;p&gt;The issue is resolved.&lt;/p&gt;</description>
      </item>
    </channel></rss>`;
    const items = parseStatusFeedXml(xml);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain("[RESOLVED] Increased error rates");
    expect(items[0]?.guid).toBe("https://status.example.com/#item1");
    expect(items[0]?.description).toBe("The issue is resolved.");
  });

  it("extracts Atom entries with href links", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>urn:uuid:1</id>
        <title>Azure networking degradation</title>
        <link href="https://status.example.com/entry/1"/>
        <updated>2026-07-31T10:00:00Z</updated>
        <summary>Investigating connectivity issues.</summary>
      </entry>
    </feed>`;
    const items = parseStatusFeedXml(xml);
    expect(items).toHaveLength(1);
    expect(items[0]?.link).toBe("https://status.example.com/entry/1");
    expect(items[0]?.publishedAt).toBe("2026-07-31T10:00:00Z");
  });
});

describe("stripStatusHtml", () => {
  it("strips tags and decodes common entities", () => {
    expect(stripStatusHtml("<p>a &amp; b<br/>c&nbsp;&quot;d&quot;</p>")).toBe('a & b c "d"');
  });
});
