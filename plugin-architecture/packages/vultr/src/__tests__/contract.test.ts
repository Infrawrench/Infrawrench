import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { describe, expect, it } from "vitest";
import { plugin } from "../plugin.js";

const creds = { apiKey: "TESTKEY000000000000000000000000000000" };

runPluginContractTests(plugin, creds);

describe("rendering", () => {
  const client = plugin.createClient(creds);
  for (const rt of plugin.resourceTypes) {
    it(`renders ${rt.id} without enrichment`, () => {
      const resource = {
        id: `acct:${rt.id}:ext-1`,
        pluginId: "vultr",
        resourceTypeId: rt.id,
        accountId: "acct",
        displayName: `Test ${rt.displayName}`,
        fields: { region: "ewr", status: "active" },
        resolvedOutputs: {},
        secretStates: [],
        externalId: "ext-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const detail = client.renderDetail(resource);
      expect(detail.title).toBe(resource.displayName);
      expect(detail.sections.length).toBeGreaterThan(0);
      if (rt.supportsMetrics) expect(detail.metricsCapability).toBeDefined();
      expect(client.renderSidebarItem(resource).label).toBe(resource.displayName);
    });
  }
});
