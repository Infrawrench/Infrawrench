import { describe, expect, it } from "vitest";
import { parseStatusFeed, statusFeed } from "../status-feed.js";

const incident = (id: string, components: { id: string; name: string }[]) => ({
  id,
  name: `Incident ${id}`,
  status: "investigating",
  impact: "minor",
  created_at: "2026-10-12T00:00:00Z",
  updated_at: "2026-10-12T01:00:00Z",
  shortlink: `https://stspg.io/${id}`,
  components,
  incident_updates: [],
});

const REPLICATE = { id: "fvgfcmy66tdr", name: "Replicate" };

describe("Replicate status feed", () => {
  it("reads Cloudflare's status page, where Replicate's status now lives", () => {
    expect(statusFeed.url).toBe(
      "https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json",
    );
  });

  it("keeps only incidents tagged with the Replicate component, as provider-wide", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        incidents: [
          incident("workers", [{ id: "x1", name: "Workers" }]),
          incident("replicate", [REPLICATE, { id: "x2", name: "Cloudflare Dashboard" }]),
          incident("renamed", [{ id: "fvgfcmy66tdr", name: "Replicate (AI)" }]),
        ],
      }),
    );
    expect(incidents.map((i) => i.externalId)).toEqual(["replicate", "renamed"]);
    expect(incidents.every((i) => i.providerWide)).toBe(true);
    expect(incidents[0]!.services).toEqual(["Replicate"]);
  });
});
