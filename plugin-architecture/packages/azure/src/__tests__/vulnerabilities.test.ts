/**
 * Defender for Cloud container image findings.
 *
 * Wire shapes follow:
 * - Resource Graph query API (request `options.$top/$skipToken`, response
 *   `data` / `$skipToken`):
 *   https://learn.microsoft.com/en-us/rest/api/azureresourcegraph/resourcegraph/resources/resources
 * - Individual recommendation records (`microsoft.security/assessments`,
 *   `metadata.recommendationCategory`, `additionalData.CvesDetails` as a JSON
 *   string, `DetectedSoftwareVersions`, `FixedVersion`):
 *   https://learn.microsoft.com/en-us/azure/defender-for-cloud/transition-grouped-individual-recommendations
 *   https://learn.microsoft.com/en-us/azure/defender-for-cloud/remediate-vulnerability-findings-vm
 * - `.containerimage` filter: Defender release notes, 2026-03-04
 *   https://learn.microsoft.com/en-us/azure/defender-for-cloud/release-notes
 * - Pricings (`properties.pricingTier`, `extensions[]`):
 *   https://learn.microsoft.com/en-us/rest/api/defenderforcloud/pricings/get
 */
import { describe, expect, it, vi } from "vitest";
import { VulnerabilityAccessError } from "@infrawrench/plugin-base";
import type { AzureResponse } from "../http.js";
import {
  ASSESSMENTS_QUERY,
  MAX_ASSESSMENT_PAGES,
  REGISTRIES_QUERY,
  RESOURCE_GRAPH_URL,
  fetchAzureVulnerabilityFindings,
  type AzureVulnerabilityContext,
} from "../vulnerabilities.js";
import { plugin } from "../plugin.js";

const SUB = "00000000-0000-0000-0000-000000000001";
const ACR_ID = `/subscriptions/${SUB}/resourceGroups/rg-shared/providers/Microsoft.ContainerRegistry/registries/contosoacr`;

function res(status: number, body: unknown): AzureResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async <T>() => body as T,
  };
}

function pricing(name: string, tier: "Free" | "Standard", registryScanning?: boolean) {
  return {
    id: `/subscriptions/${SUB}/providers/Microsoft.Security/pricings/${name}`,
    name,
    type: "Microsoft.Security/pricings",
    properties: {
      pricingTier: tier,
      freeTrialRemainingTime: "PT0S",
      ...(registryScanning === undefined
        ? {}
        : {
            extensions: [
              {
                name: "ContainerRegistriesVulnerabilityAssessments",
                isEnabled: registryScanning ? "True" : "False",
              },
            ],
          }),
    },
  };
}

/** One individual recommendation for (image, package), as Resource Graph returns it. */
function assessment(overrides: {
  key: string;
  status?: string;
  cves: unknown[];
  software?: string;
  detected?: string[];
  fixed?: string;
  severity?: string;
  repository?: string;
  digest?: string;
  registryId?: string;
}) {
  const repo = overrides.repository ?? "payments/api";
  const digest =
    overrides.digest ?? "sha256:9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08";
  const resourceId = `${overrides.registryId ?? ACR_ID}/repositories-${repo.replace("/", "-")}-images-${digest.replace("sha256:", "")}`;
  return {
    id: `${resourceId}/providers/Microsoft.Security/assessments/${overrides.key}`,
    name: overrides.key,
    properties: {
      displayName: `Upgrade ${overrides.software ?? "openssl"} to fix vulnerabilities`,
      status: {
        code: overrides.status ?? "Unhealthy",
        firstEvaluationDate: "2026-09-01T08:00:00Z",
        statusChangeDate: "2026-10-10T08:00:00Z",
      },
      metadata: {
        recommendationCategory: "SoftwareUpdate",
        severity: overrides.severity ?? "High",
      },
      resourceDetails: {
        Source: "Azure",
        ResourceType: ".containerimage",
        Id: resourceId,
      },
      resourceAdditionalData: JSON.stringify({
        Digest: digest,
        RepositoryDetails: {
          RepositoryName: repo,
          LastPushedToRegistryUTC: "2026-08-30T00:00:00Z",
        },
      }),
      additionalData: {
        SoftwareName: overrides.software ?? "openssl",
        DetectedSoftwareVersions: JSON.stringify(overrides.detected ?? ["3.0.2-0ubuntu1.10"]),
        FixedVersion: overrides.fixed ?? "",
        PackageType: "Os",
        CvesDetails: JSON.stringify(overrides.cves),
      },
      links: {
        azurePortalUri: `#view/Microsoft_Azure_Security/GenericRecommendationDetailsBlade/assessmentKey/${overrides.key}`,
      },
    },
  };
}

interface Routes {
  containers?: AzureResponse;
  cspm?: AzureResponse;
  assessmentPages?: AzureResponse[];
  registries?: AzureResponse;
  cveDetails?: AzureResponse;
}

function makeCtx(routes: Routes) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let assessmentPage = 0;
  const request = vi.fn(async (method: "GET" | "POST", url: string, body?: unknown) => {
    calls.push({ method, url, body });
    if (url.includes("/pricings/Containers")) {
      return routes.containers ?? res(200, pricing("Containers", "Standard", true));
    }
    if (url.includes("/pricings/CloudPosture")) {
      return routes.cspm ?? res(200, pricing("CloudPosture", "Free"));
    }
    if (url === RESOURCE_GRAPH_URL) {
      const query = (body as { query: string }).query;
      if (query === ASSESSMENTS_QUERY) {
        const pages = routes.assessmentPages ?? [res(200, { data: [] })];
        return pages[Math.min(assessmentPage++, pages.length - 1)]!;
      }
      if (query === REGISTRIES_QUERY) {
        return (
          routes.registries ??
          res(200, {
            data: [{ id: ACR_ID, name: "contosoacr", loginServer: "contosoacr.azurecr.io" }],
          })
        );
      }
      if (query.includes("microsoft.security/cvedetails")) {
        return routes.cveDetails ?? res(200, { data: [] });
      }
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  const ctx: AzureVulnerabilityContext = { subscriptionId: SUB, request };
  return { ctx, calls, request };
}

describe("fetchAzureVulnerabilityFindings", () => {
  it("maps each CVE of an unhealthy image recommendation to an image finding", async () => {
    const { ctx, calls } = makeCtx({
      assessmentPages: [
        res(200, {
          totalRecords: 1,
          count: 1,
          data: [
            assessment({
              key: "a1b2c3d4-0000-0000-0000-000000000001",
              fixed: "3.0.2-0ubuntu1.15",
              cves: [
                {
                  CveId: "CVE-2024-5535",
                  Severity: "Critical",
                  Cvss: [{ Version: "3.1", Value: { Base: 9.1 } }],
                  FixStatus: "FixAvailable",
                  ExploitabilityDetails: { IsInExploitKit: false, ExploitStepsPublished: true },
                },
                { CveId: "cve-2024-0727" },
              ],
            }),
          ],
        }),
      ],
      cveDetails: res(200, {
        data: [
          {
            id: "/providers/Microsoft.Security/cvedetails/CVE-2024-0727",
            cveIdJoin: "CVE-2024-0727",
            properties: {
              cveId: "CVE-2024-0727",
              severity: "Medium",
              cvss: { "3.0": { base: 5.5 } },
              exploitabilityDetails: { IsInExploitKit: false, IsVerified: false },
            },
          },
        ],
      }),
    });

    const findings = await fetchAzureVulnerabilityFindings(ctx);
    expect(findings).toHaveLength(2);

    const critical = findings.find((f) => f.advisoryId === "CVE-2024-5535")!;
    expect(critical).toMatchObject({
      severity: "critical",
      cvssScore: 9.1,
      packageName: "openssl",
      packageEcosystem: "os",
      installedVersion: "3.0.2-0ubuntu1.10",
      fixedVersion: "3.0.2-0ubuntu1.15",
      fixAvailable: true,
      exploitAvailable: true,
      title: "Upgrade openssl to fix vulnerabilities",
      firstSeenAt: "2026-09-01T08:00:00Z",
      lastSeenAt: "2026-10-10T08:00:00Z",
      artifact: {
        kind: "image",
        name: "contosoacr.azurecr.io/payments/api",
        digest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
    });
    expect(critical.id).toMatch(/assessments\/a1b2c3d4-0000-0000-0000-000000000001#CVE-2024-5535$/);
    expect(critical.url).toBe(
      "https://portal.azure.com/#view/Microsoft_Azure_Security/GenericRecommendationDetailsBlade/assessmentKey/a1b2c3d4-0000-0000-0000-000000000001",
    );

    // Not inline: enriched from the tenant-level cvedetails table.
    const medium = findings.find((f) => f.advisoryId === "CVE-2024-0727")!;
    expect(medium).toMatchObject({ severity: "medium", cvssScore: 5.5, exploitAvailable: false });
    // A package-level fixed version is the scanner saying a fix exists.
    expect(medium.fixAvailable).toBe(true);

    const graphCalls = calls.filter((c) => c.url === RESOURCE_GRAPH_URL);
    expect(graphCalls[0]!.body).toMatchObject({
      subscriptions: [SUB],
      options: { $top: 1000, resultFormat: "objectArray" },
    });
    // The CVE detail table is tenant-level: no subscription scope.
    const cveCall = graphCalls.find((c) =>
      (c.body as { query: string }).query.includes("cvedetails"),
    )!;
    expect(cveCall.body).not.toHaveProperty("subscriptions");
  });

  it("leaves fixAvailable unknown when the scanner gives neither a status nor a version", async () => {
    const { ctx } = makeCtx({
      assessmentPages: [
        res(200, {
          data: [
            assessment({
              key: "k-nofix",
              severity: "Low",
              cves: [{ CveId: "CVE-2023-4911" }],
            }),
          ],
        }),
      ],
    });
    const [finding] = await fetchAzureVulnerabilityFindings(ctx);
    expect(finding!.fixAvailable).toBeUndefined();
    expect(finding!.exploitAvailable).toBeUndefined();
    // No per-CVE severity or score anywhere: the recommendation's own severity.
    expect(finding!.severity).toBe("low");
  });

  it("reports NoFixAvailable as no fix", async () => {
    const { ctx } = makeCtx({
      assessmentPages: [
        res(200, {
          data: [
            assessment({
              key: "k-wontfix",
              cves: [{ CveId: "CVE-2022-0001", Severity: "High", FixStatus: "NoFixAvailable" }],
            }),
          ],
        }),
      ],
    });
    const [finding] = await fetchAzureVulnerabilityFindings(ctx);
    expect(finding!.fixAvailable).toBe(false);
  });

  it("skips anything not Unhealthy, even if the query let it through", async () => {
    const { ctx } = makeCtx({
      assessmentPages: [
        res(200, {
          data: [
            assessment({ key: "k-healthy", status: "Healthy", cves: [{ CveId: "CVE-2024-1" }] }),
          ],
        }),
      ],
    });
    expect(await fetchAzureVulnerabilityFindings(ctx)).toEqual([]);
  });

  it("falls back to the default login server for a registry outside the subscription", async () => {
    const otherAcr =
      "/subscriptions/other/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/SharedImages";
    const { ctx } = makeCtx({
      assessmentPages: [
        res(200, {
          data: [
            assessment({
              key: "k-other",
              registryId: otherAcr,
              repository: "base/node",
              cves: [{ CveId: "CVE-2024-2", Severity: "High" }],
            }),
          ],
        }),
      ],
    });
    const [finding] = await fetchAzureVulnerabilityFindings(ctx);
    expect(finding!.artifact.name).toBe("sharedimages.azurecr.io/base/node");
  });

  it("follows $skipToken and stops at the page bound", async () => {
    const page = (n: number) =>
      res(200, {
        data: [
          assessment({ key: `k-${n}`, cves: [{ CveId: `CVE-2024-${1000 + n}`, Severity: "Low" }] }),
        ],
        $skipToken: `token-${n}`,
      });
    const pages = Array.from({ length: MAX_ASSESSMENT_PAGES + 5 }, (_, i) => page(i));
    const { ctx, calls } = makeCtx({ assessmentPages: pages });
    const findings = await fetchAzureVulnerabilityFindings(ctx);
    expect(findings).toHaveLength(MAX_ASSESSMENT_PAGES);
    const assessmentCalls = calls.filter(
      (c) => (c.body as { query?: string } | undefined)?.query === ASSESSMENTS_QUERY,
    );
    expect(assessmentCalls).toHaveLength(MAX_ASSESSMENT_PAGES);
    expect(assessmentCalls[1]!.body).toMatchObject({ options: { $skipToken: "token-0" } });
  });

  it("still returns findings when the CVE detail table is not visible", async () => {
    const { ctx } = makeCtx({
      assessmentPages: [
        res(200, { data: [assessment({ key: "k1", cves: [{ CveId: "CVE-2024-3" }] })] }),
      ],
      cveDetails: res(403, { error: { code: "AuthorizationFailed", message: "no" } }),
    });
    const [finding] = await fetchAzureVulnerabilityFindings(ctx);
    expect(finding!.advisoryId).toBe("CVE-2024-3");
    expect(finding!.cvssScore).toBeUndefined();
    expect(finding!.severity).toBe("high");
  });

  it("throws VulnerabilityAccessError when neither Defender plan is on", async () => {
    const { ctx } = makeCtx({
      containers: res(200, pricing("Containers", "Free")),
      cspm: res(200, pricing("CloudPosture", "Free")),
    });
    await expect(fetchAzureVulnerabilityFindings(ctx)).rejects.toBeInstanceOf(
      VulnerabilityAccessError,
    );
  });

  it("throws VulnerabilityAccessError when the plan is on but registry access is off", async () => {
    const { ctx } = makeCtx({
      containers: res(200, pricing("Containers", "Standard", false)),
      cspm: res(404, { error: { code: "NotFound" } }),
    });
    await expect(fetchAzureVulnerabilityFindings(ctx)).rejects.toThrow(/registry access/);
  });

  it("accepts Defender CSPM alone", async () => {
    const { ctx } = makeCtx({
      containers: res(200, pricing("Containers", "Free")),
      cspm: res(200, pricing("CloudPosture", "Standard", true)),
    });
    await expect(fetchAzureVulnerabilityFindings(ctx)).resolves.toEqual([]);
  });

  it("throws VulnerabilityAccessError on a refused plan read or query", async () => {
    const refusedPlan = makeCtx({
      containers: res(403, { error: { code: "AuthorizationFailed" } }),
    });
    await expect(fetchAzureVulnerabilityFindings(refusedPlan.ctx)).rejects.toBeInstanceOf(
      VulnerabilityAccessError,
    );
    const refusedQuery = makeCtx({ assessmentPages: [res(403, { error: { code: "Forbidden" } })] });
    await expect(fetchAzureVulnerabilityFindings(refusedQuery.ctx)).rejects.toBeInstanceOf(
      VulnerabilityAccessError,
    );
  });

  it("fails loudly (never a short list) on a transient Resource Graph error", async () => {
    const { ctx } = makeCtx({
      assessmentPages: [
        res(200, {
          data: [assessment({ key: "k1", cves: [{ CveId: "CVE-2024-4" }] })],
          $skipToken: "t",
        }),
        res(429, { error: { code: "RateLimiting" } }),
      ],
    });
    await expect(fetchAzureVulnerabilityFindings(ctx)).rejects.toThrow(/429/);
  });
});

describe("Azure vulnerability declarations", () => {
  it("declares the capability", () => {
    expect(plugin.manifest.vulnerabilities).toMatchObject({
      label: "Microsoft Defender for Cloud",
      requiresElevatedCredential: true,
      partial: true,
    });
  });

  it("declares runningImages only over fields the type defines", () => {
    const declared = plugin.resourceTypes.filter((t) => t.runningImages);
    expect(declared.map((t) => t.id).sort()).toEqual([
      "azure-app-service",
      "azure-container-app",
      "azure-container-app-job",
      "azure-container-instance",
      "azure-function-app",
    ]);
    for (const type of declared) {
      const keys = new Set(type.fields.map((f) => f.key));
      for (const key of [
        ...type.runningImages!.imageKeys,
        ...(type.runningImages!.digestKeys ?? []),
        ...(type.runningImages!.runningKey ? [type.runningImages!.runningKey] : []),
      ]) {
        expect(keys.has(key), `${type.id}.${key}`).toBe(true);
      }
    }
  });
});
