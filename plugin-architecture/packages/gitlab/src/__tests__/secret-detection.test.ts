import { describe, expect, it } from "vitest";
import type { GitLabContext } from "../api.js";
import {
  listSecretDetectionFindings,
  resolveSecretDetectionFinding,
  vulnerabilityTokenType,
} from "../secret-detection.js";
import { makeHttp } from "./helpers.js";

const ctx = (http: ReturnType<typeof makeHttp>["http"]): GitLabContext => ({
  baseUrl: "https://gitlab.com",
  token: "tok",
  http,
});

const vuln = (id: number, state = "DETECTED") => ({
  id: `gid://gitlab/Vulnerability/${id}`,
  title: "GitLab personal access token",
  state,
  detectedAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  webUrl: `https://gitlab.com/acme/app/-/security/vulnerabilities/${id}`,
  dismissalReason: null,
  identifiers: [
    {
      externalType: "gitleaks_rule_id",
      externalId: "gitlab_personal_access_token",
      name: "Gitleaks rule ID gitlab_personal_access_token",
    },
  ],
  location: { file: ".env", startLine: "3" },
});

describe("secret detection", () => {
  it("reads secret detection vulnerabilities per project batch and maps them", async () => {
    const { http, calls } = makeHttp(() => ({
      data: {
        projects: {
          nodes: [
            {
              fullPath: "acme/app",
              vulnerabilities: {
                nodes: [vuln(1), vuln(2, "RESOLVED")],
                pageInfo: { hasNextPage: false },
              },
            },
            { fullPath: "acme/free-tier", vulnerabilities: null },
          ],
        },
      },
    }));
    const page = await listSecretDetectionFindings(
      ctx(http),
      [
        { id: 11, path_with_namespace: "acme/app" },
        { id: 12, path_with_namespace: "acme/free-tier" },
      ],
      { limit: 100, includeResolved: false },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/api/graphql");
    expect((calls[0]!.body as { variables: { ids: string[] } }).variables.ids).toEqual([
      "gid://gitlab/Project/11",
      "gid://gitlab/Project/12",
    ]);
    expect(page.findings).toEqual([
      {
        ref: "gid://gitlab/Vulnerability/1",
        tokenType: "gitlab_personal_access_token",
        tokenTypeLabel: "GitLab personal access token",
        state: "open",
        location: { repository: "acme/app", path: ".env", line: 3 },
        url: "https://gitlab.com/acme/app/-/security/vulnerabilities/1",
        detectedAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
      },
    ]);
    // Never a raw value: GitLab does not return one.
    expect(page.findings[0]).not.toHaveProperty("secret");
  });

  it("throws when every batch failed, so the scan reports why", async () => {
    const { http } = makeHttp(() => ({
      errors: [{ message: "Field 'vulnerabilities' requires Ultimate" }],
    }));
    await expect(
      listSecretDetectionFindings(ctx(http), [{ id: 1, path_with_namespace: "a/b" }], {
        limit: 10,
        includeResolved: true,
      }),
    ).rejects.toThrow(/could not be read/);
  });

  it("falls back to the identifier name or title for the token type", () => {
    expect(
      vulnerabilityTokenType({ id: "x", state: "DETECTED", identifiers: [{ name: "AWS" }] }),
    ).toBe("AWS");
    expect(vulnerabilityTokenType({ id: "x", state: "DETECTED", title: "Generic" })).toBe(
      "Generic",
    );
  });

  it("resolves a rotated secret and dismisses with GitLab's reason", async () => {
    const { http, calls } = makeHttp(() => ({
      data: { vulnerabilityResolve: { errors: [] }, vulnerabilityDismiss: { errors: [] } },
    }));
    await resolveSecretDetectionFinding(ctx(http), "gid://gitlab/Vulnerability/1", {
      reason: "revoked",
      comment: "Rotated",
    });
    await resolveSecretDetectionFinding(ctx(http), "gid://gitlab/Vulnerability/1", {
      reason: "used-in-tests",
    });
    const bodies = calls.map(
      (c) => c.body as { query: string; variables: Record<string, unknown> },
    );
    expect(bodies[0]!.query).toContain("vulnerabilityResolve");
    expect(bodies[1]!.query).toContain("vulnerabilityDismiss");
    expect(bodies[1]!.variables["reason"]).toBe("USED_IN_TESTS");
  });

  it("surfaces mutation errors other than an already-resolved state", async () => {
    const { http } = makeHttp(() => ({
      data: { vulnerabilityResolve: { errors: ["Permission denied"] } },
    }));
    await expect(
      resolveSecretDetectionFinding(ctx(http), "gid://gitlab/Vulnerability/1", {
        reason: "revoked",
      }),
    ).rejects.toThrow(/Permission denied/);
    const already = makeHttp(() => ({
      data: { vulnerabilityResolve: { errors: ["Vulnerability is already resolved"] } },
    }));
    await expect(
      resolveSecretDetectionFinding(ctx(already.http), "gid://gitlab/Vulnerability/1", {
        reason: "revoked",
      }),
    ).resolves.toBeUndefined();
  });
});
