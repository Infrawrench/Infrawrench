import { describe, expect, it } from "vitest";
import { parseStatusFeed } from "../status-feed.js";

function incident(component: string) {
  return JSON.stringify({
    incidents: [
      {
        id: "inc-1",
        name: "Degraded performance",
        status: "investigating",
        impact: "minor",
        created_at: "2026-09-01T10:00:00Z",
        updated_at: "2026-09-01T10:05:00Z",
        shortlink: "https://stspg.io/x",
        components: [{ id: "c-1", name: component }],
        incident_updates: [
          { body: "Looking into it", status: "investigating", created_at: "2026-09-01T10:05:00Z" },
        ],
      },
    ],
  });
}

describe("parseStatusFeed component mapping", () => {
  it.each([
    ["Spaces", "spaces-bucket"],
    ["Spaces CDN", "cdn-endpoint"],
    ["App Platform", "app"],
    ["Load Balancers", "load-balancer"],
    ["VPC", "vpc-nat-gateway"],
    ["Network File Storage", "nfs-share"],
    ["Agentic Inference Cloud", "gen-ai-agent"],
  ])("maps the %s component onto %s", (component, typeId) => {
    const [inc] = parseStatusFeed(incident(component));
    expect(JSON.stringify(inc)).toContain(`"${typeId}"`);
  });
});
