import { it, expect } from "vitest";
import { runPluginRenderingTests, createMockResource } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginRenderingTests(plugin, (client) => {
  const azureStorageRt = plugin.resourceTypes.find((rt) => rt.id === "azure-storage-account");

  if (azureStorageRt) {
    it("renderDetail storage browser present for storage accounts", () => {
      const resource = createMockResource(plugin.manifest.id, azureStorageRt);
      const schema = client.renderDetail(resource);
      expect(schema.storageBrowser).toBeDefined();
      expect(schema.storageBrowser!.bucketName).toBeTruthy();
    });
  }
});
