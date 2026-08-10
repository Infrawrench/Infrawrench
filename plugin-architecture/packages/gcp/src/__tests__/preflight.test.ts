import { describe, it, expect, vi, afterEach } from "vitest";
import { buildGcpPolicyTemplate, gcpPreflight, runGcpPreflight } from "../preflight.js";
import type { ServiceAccountKey } from "../auth.js";

vi.mock("../auth.js", () => ({
  fetchAccessToken: vi.fn().mockResolvedValue("test-token"),
}));

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

  it("covers every lister the client ships in the resources permission set", () => {
    const perms = buildGcpPolicyTemplate(["resources"])
      .document.trimEnd()
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2));
    // One exact list permission per resource type in client.ts listResources
    // (verified against each API's reference docs — no wildcards).
    for (const required of [
      "aiplatform.endpoints.list",
      "alloydb.clusters.list",
      "alloydb.instances.list",
      "appengine.services.list",
      "cloudbuild.builds.list",
      "clouddeploy.deliveryPipelines.list",
      "cloudkms.cryptoKeys.list",
      "cloudkms.keyRings.list",
      "cloudkms.locations.list",
      "composer.environments.list",
      "compute.securityPolicies.list",
      "dataflow.jobs.list",
      "file.instances.list",
      "iam.serviceAccounts.list",
    ]) {
      expect(perms).toContain(required);
    }
    // The instance-group lister reads aggregated instanceGroupManagers, not
    // instanceGroups — the permission must match the API actually called.
    expect(perms).toContain("compute.instanceGroupManagers.list");
    expect(perms).not.toContain("compute.instanceGroups.list");
  });
});

const TEST_KEY = { client_email: "sa@test.iam.gserviceaccount.com" } as ServiceAccountKey;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runGcpPreflight", () => {
  function stubTestIamPermissions(granted: (requested: string[]) => string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const { permissions } = JSON.parse(String(init?.body)) as { permissions: string[] };
        return new Response(JSON.stringify({ permissions: granted(permissions) }), {
          status: 200,
        });
      }),
    );
  }

  it("keeps IAM missing permissions on the costs check when the export table is blank", async () => {
    // Everything granted except the two costs permissions.
    const costsPerms = new Set(["bigquery.jobs.create", "bigquery.tables.getData"]);
    stubTestIamPermissions((requested) => requested.filter((p) => !costsPerms.has(p)));
    const result = await runGcpPreflight(TEST_KEY, "test-project", "");
    const costs = result.checks.find((c) => c.capabilityId === "costs")!;
    expect(costs.status).toBe("missing");
    if (costs.status !== "missing") throw new Error("unreachable");
    // Both failure states are reported together: the IAM gaps survive the
    // blank-export-table override instead of being reset.
    expect(costs.missingPermissions.map((p) => p.id)).toEqual([
      "bigquery.jobs.create",
      "bigquery.tables.getData",
    ]);
    expect(costs.message).toContain("Billing export table");
    expect(result.checks.find((c) => c.capabilityId === "resources")!.status).toBe("ok");
  });

  it("still reports the blank export table when IAM is fully granted", async () => {
    stubTestIamPermissions((requested) => requested);
    const result = await runGcpPreflight(TEST_KEY, "test-project", "");
    const costs = result.checks.find((c) => c.capabilityId === "costs")!;
    expect(costs.status).toBe("missing");
    if (costs.status !== "missing") throw new Error("unreachable");
    expect(costs.missingPermissions).toEqual([]);
    expect(costs.message).toContain("Billing export table");
  });
});
