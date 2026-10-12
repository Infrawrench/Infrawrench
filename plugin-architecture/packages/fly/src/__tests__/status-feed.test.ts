import { describe, expect, it } from "vitest";
import { parseStatusFeed, statusFeed } from "../status-feed.js";

const incident = (id: string, status: string, components: string[] = []) => ({
  id,
  name: `Incident ${id}`,
  status,
  impact: "minor",
  created_at: "2026-10-12T00:00:00Z",
  updated_at: "2026-10-12T01:00:00Z",
  resolved_at: status === "resolved" ? "2026-10-12T01:00:00Z" : null,
  components: components.map((name) => ({ name })),
  incident_updates: [],
});

describe("Fly status feed", () => {
  it("reads the incident.io history endpoint, not the retired unresolved.json", () => {
    expect(statusFeed.url).toBe("https://status.flyio.net/api/v2/incidents.json");
  });

  it("keeps unresolved incidents and maps region and volume components", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        incidents: [
          incident("a", "investigating", ["LHR - London, United Kingdom"]),
          incident("b", "monitoring", ["Persistent Storage (Volumes)"]),
          incident("c", "resolved", ["IAD - Ashburn, Virginia (US)"]),
        ],
      }),
    );
    expect(incidents.map((i) => i.externalId)).toEqual(["a", "b"]);
    expect(incidents[0]!.regions).toEqual(["lhr"]);
    expect(incidents[1]!.resourceTypes).toEqual(["volume"]);
  });
});
