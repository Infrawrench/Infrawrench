import { describe, it, expect } from "vitest";
import { plugin } from "../plugin.js";
import { createMockResource, makeMockCredentials } from "@infrawrench/plugin-base/test-harness";
import { detailViewSchema } from "@infrawrench/plugin-base";

const client = plugin.createClient(makeMockCredentials(plugin.manifest.id));

describe(`${plugin.manifest.displayName} rendering`, () => {
  for (const rt of plugin.resourceTypes) {
    describe(rt.id, () => {
      const resource = createMockResource(plugin.manifest.id, rt);

      it("renderDetail returns valid schema", () => {
        const schema = client.renderDetail(resource);
        const result = detailViewSchema.safeParse(schema);
        if (!result.success) console.error(rt.id, result.error.issues);
        expect(result.success).toBe(true);
      });

      it("renderDetail has non-empty title", () => {
        const schema = client.renderDetail(resource);
        expect(schema.title).toBeTruthy();
      });

      it("renderDetail has at least one section", () => {
        const schema = client.renderDetail(resource);
        expect(schema.sections.length).toBeGreaterThan(0);
      });

      it("renderSidebarItem returns valid shape", () => {
        const item = client.renderSidebarItem(resource);
        expect(typeof item.id).toBe("string");
        expect(item.id.length).toBeGreaterThan(0);
        expect(typeof item.label).toBe("string");
        expect(item.label.length).toBeGreaterThan(0);
      });

      it("renderDetail storage browser present for storage accounts", () => {
        if (rt.id === "azure-storage-account") {
          const schema = client.renderDetail(resource);
          expect(schema.storageBrowser).toBeDefined();
          expect(schema.storageBrowser!.bucketName).toBeTruthy();
        }
      });
    });
  }
});
