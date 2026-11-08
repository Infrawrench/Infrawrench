import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const mockIncidents = vi.fn();
vi.mock("@infrawrench/server-core/status/match", () => ({
  getOrgStatusIncidents: (...a: unknown[]) => mockIncidents(...a),
}));

const { statusIncidentsDomain } = await import("@/http/domains/status-incidents/index");

const buildApp = (permissions?: string[]) =>
  buildTestApi(statusIncidentsDomain, {
    basePath: "/api/org/org-1/status-incidents",
    ...(permissions ? { permissions } : {}),
  });

const incident = {
  id: "inc-1",
  pluginId: "digitalocean",
  pluginName: "DigitalOcean",
  title: "Droplet creation delayed",
  state: "investigating",
  impact: "minor",
  url: null,
  startedAt: "2026-10-01T00:00:00.000Z",
  resolvedAt: null,
  lastUpdateAt: null,
  lastUpdateText: null,
  regions: ["nyc1"],
  services: ["Droplets"],
  providerWide: false,
  affectedResourceCount: 2,
  affectedRegions: ["nyc1"],
  sampleResources: [{ id: "r1", displayName: "web-1", resourceTypeId: "droplet", region: "nyc1" }],
  overlappingChangeCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIncidents.mockResolvedValue([incident]);
});

describe("GET /status-incidents", () => {
  it("wraps the org's correlated incidents", async () => {
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ incidents: [incident] });
    expect(mockIncidents).toHaveBeenCalledWith("org-1");
  });

  it("needs resources:read", async () => {
    expect((await buildApp([]).request("/")).status).toBe(403);
    expect(mockIncidents).not.toHaveBeenCalled();
  });
});
