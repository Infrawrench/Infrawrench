import { describe, it, expect } from "vitest";
import { buildGcpPolicyTemplate, gcpPreflight } from "../preflight.js";

describe("gcpPreflight declaration", () => {
  it("declares resources/metrics/costs with GCP permission strings", () => {
    expect(gcpPreflight.capabilities.map((c) => c.id)).toEqual(["resources", "metrics", "costs"]);
    const resources = gcpPreflight.capabilities.find((c) => c.id === "resources")!;
    expect(resources.essential).toBe(true);
    expect(resources.requiredPermissions.map((p) => p.id)).toContain("compute.instances.list");
    // There is no bigquery.datasets.list — listing datasets needs .get.
    expect(resources.requiredPermissions.map((p) => p.id)).toContain("bigquery.datasets.get");
    expect(gcpPreflight.templateFormat).toEqual({
      label: "GCP custom role (YAML)",
      language: "yaml",
    });
  });
});

describe("buildGcpPolicyTemplate", () => {
  it("emits a gcloud-compatible custom role definition", () => {
    const tpl = buildGcpPolicyTemplate(["metrics", "costs"]);
    expect(tpl.language).toBe("yaml");
    const lines = tpl.document.trimEnd().split("\n");
    expect(lines[0]).toBe('title: "Infrawrench"');
    expect(lines).toContain('stage: "GA"');
    expect(lines).toContain("includedPermissions:");
    expect(lines).toContain("- monitoring.timeSeries.list");
    expect(lines).toContain("- bigquery.jobs.create");
    expect(lines).toContain("- bigquery.tables.getData");
    // resources permissions must not leak into a metrics+costs template
    expect(lines).not.toContain("- compute.instances.list");
  });

  it("deduplicates and sorts permissions across capabilities", () => {
    const tpl = buildGcpPolicyTemplate(["resources", "metrics", "costs"]);
    const perms = tpl.document
      .trimEnd()
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2));
    expect(new Set(perms).size).toBe(perms.length);
    expect([...perms].sort()).toEqual(perms);
    // No wildcards — GCP custom roles reject them.
    expect(perms.some((p) => p.includes("*"))).toBe(false);
  });

  it("mentions where to apply the role", () => {
    const tpl = buildGcpPolicyTemplate(["resources"]);
    expect(tpl.instructions).toContain("gcloud iam roles create");
    expect(tpl.helpLink?.url).toMatch(/^https:\/\//);
  });
});
