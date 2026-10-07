import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { describe, expect, it } from "vitest";
import { plugin } from "../plugin.js";

const creds = {
  apiKey: "EXO0123456789abcdef01234567",
  apiSecret: "test-secret-0000000000000000000000000000",
};

runPluginContractTests(plugin, creds);

describe("rendering", () => {
  const client = plugin.createClient(creds);
  for (const rt of plugin.resourceTypes) {
    it(`renders ${rt.id} without enrichment`, () => {
      const resource = {
        id: `acct:${rt.id}:ch-gva-2/ext-1`,
        pluginId: "exoscale",
        resourceTypeId: rt.id,
        accountId: "acct",
        displayName: `Test ${rt.displayName}`,
        fields: { region: "ch-gva-2", state: "running" },
        resolvedOutputs: {},
        secretStates: [],
        externalId: "ch-gva-2/ext-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const detail = client.renderDetail(resource);
      expect(detail.title).toBe(resource.displayName);
      if (rt.supportsMetrics) expect(detail.metricsCapability).toBeDefined();
      expect(client.renderSidebarItem(resource).label).toBe(resource.displayName);
    });
  }
});
