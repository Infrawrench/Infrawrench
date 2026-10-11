import { VulnerabilityAccessError } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import type { GitLabContext } from "../api.js";
import { plugin } from "../plugin.js";
import type { GlVulnerability } from "../vulnerabilities.js";
import {
  fetchGitLabVulnerabilities,
  mapGitLabVulnerability,
  parseImageRef,
} from "../vulnerabilities.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

/**
 * Nodes shaped after the `Vulnerability` type and the
 * `VulnerabilityLocationDependencyScanning` / `...ContainerScanning` location
 * types in the GraphQL reference
 * (https://docs.gitlab.com/api/graphql/reference/#vulnerability).
 */
const DEPENDENCY: GlVulnerability = {
  id: "gid://gitlab/Vulnerability/101",
  title: "Prototype Pollution in lodash",
  name: "Prototype Pollution in lodash",
  state: "DETECTED",
  severity: "HIGH",
  reportType: "DEPENDENCY_SCANNING",
  detectedAt: "2026-09-01T10:00:00Z",
  webUrl: "https://gitlab.com/acme/web/-/security/vulnerabilities/101",
  resolvedOnDefaultBranch: false,
  hasRemediations: true,
  identifiers: [
    {
      externalType: "gemnasium",
      externalId: "7f1e0b48-1e7c-4a21-9d5b-1b1a9f6f3f0e",
      name: "Gemnasium-7f1e0b48",
      url: "https://gitlab.com/gitlab-org/security-products/gemnasium-db",
    },
    {
      externalType: "cve",
      externalId: "CVE-2020-8203",
      name: "CVE-2020-8203",
      url: "https://nvd.nist.gov/vuln/detail/CVE-2020-8203",
    },
    {
      externalType: "ghsa",
      externalId: "GHSA-p6mc-m468-83gw",
      name: "GHSA-p6mc-m468-83gw",
      url: null,
    },
  ],
  primaryIdentifier: {
    externalType: "gemnasium",
    externalId: "7f1e0b48",
    name: "Gemnasium-7f1e0b48",
  },
  cvss: [
    { vector: "AV:N/AC:H/Au:N/C:N/I:P/A:P", baseScore: 5.8, version: 2 },
    { vector: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H", baseScore: 7.4, version: 3.1 },
  ],
  cveEnrichment: { isKnownExploit: false },
  scanner: { name: "Gemnasium" },
  project: {
    id: "gid://gitlab/Project/42",
    fullPath: "acme/web",
    webUrl: "https://gitlab.com/acme/web",
  },
  location: {
    __typename: "VulnerabilityLocationDependencyScanning",
    file: "package-lock.json",
    dependency: { version: "4.17.15", package: { name: "lodash" } },
  },
};

const CONTAINER: GlVulnerability = {
  id: "gid://gitlab/Vulnerability/202",
  title: "CVE-2023-4911 in glibc",
  state: "CONFIRMED",
  severity: "CRITICAL",
  reportType: "CONTAINER_SCANNING",
  detectedAt: "2026-09-02T10:00:00Z",
  webUrl: "https://gitlab.com/acme/web/-/security/vulnerabilities/202",
  resolvedOnDefaultBranch: false,
  hasRemediations: false,
  identifiers: [{ externalType: "cve", externalId: "CVE-2023-4911", name: "CVE-2023-4911" }],
  cvss: [],
  cveEnrichment: { isKnownExploit: true },
  project: {
    id: "gid://gitlab/Project/42",
    fullPath: "acme/web",
    webUrl: "https://gitlab.com/acme/web",
  },
  location: {
    __typename: "VulnerabilityLocationContainerScanning",
    image:
      "registry.gitlab.com/acme/web/app:main@sha256:bc09fe2e0721dfaeee79364115aeedf2174cce0947b9ae5fe7c33312ee019a4e",
    operatingSystem: "debian 12",
    dependency: { version: "2.36-9+deb12u1", package: { name: "glibc" } },
  },
};

const ctxWith = (http: ReturnType<typeof makeHttp>["http"]): GitLabContext => ({
  baseUrl: "https://gitlab.com",
  token: "glpat-test",
  http,
});

const page = (scope: unknown) => ({ data: { scope } });

describe("parseImageRef", () => {
  it("splits repository, tag and digest", () => {
    expect(
      parseImageRef(
        "registry.gitlab.com/acme/web/app:main@sha256:bc09fe2e0721dfaeee79364115aeedf2174cce0947b9ae5fe7c33312ee019a4e",
      ),
    ).toEqual({
      name: "registry.gitlab.com/acme/web/app",
      tag: "main",
      digest: "sha256:bc09fe2e0721dfaeee79364115aeedf2174cce0947b9ae5fe7c33312ee019a4e",
    });
  });

  it("expands Docker Hub short names and keeps registry ports", () => {
    expect(parseImageRef("python:3.12")).toEqual({ name: "docker.io/library/python", tag: "3.12" });
    expect(parseImageRef("bitnami/redis")).toEqual({ name: "docker.io/bitnami/redis" });
    expect(parseImageRef("reg.local:5000/team/api:1")).toEqual({
      name: "reg.local:5000/team/api",
      tag: "1",
    });
  });
});

describe("mapGitLabVulnerability", () => {
  it("maps a dependency-scanning finding onto the project", () => {
    expect(mapGitLabVulnerability(DEPENDENCY)).toEqual({
      id: "gid://gitlab/Vulnerability/101",
      advisoryId: "CVE-2020-8203",
      aliases: ["GHSA-p6mc-m468-83gw"],
      title: "Prototype Pollution in lodash",
      severity: "high",
      cvssScore: 7.4,
      cvssVector: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H",
      packageName: "lodash",
      installedVersion: "4.17.15",
      fixAvailable: true,
      artifact: {
        kind: "repository",
        name: "acme/web",
        resourceExternalId: "42",
        url: "https://gitlab.com/acme/web",
      },
      firstSeenAt: "2026-09-01T10:00:00Z",
      url: "https://gitlab.com/acme/web/-/security/vulnerabilities/101",
    });
  });

  it("maps a container-scanning finding onto the image, leaving unknowns absent", () => {
    const f = mapGitLabVulnerability(CONTAINER)!;
    expect(f.artifact).toEqual({
      kind: "image",
      name: "registry.gitlab.com/acme/web/app",
      digest: "sha256:bc09fe2e0721dfaeee79364115aeedf2174cce0947b9ae5fe7c33312ee019a4e",
      tags: ["main"],
    });
    expect(f.severity).toBe("critical");
    expect(f.exploitAvailable).toBe(true);
    expect("fixAvailable" in f).toBe(false);
    expect("fixedVersion" in f).toBe(false);
    expect(f.packageName).toBe("glibc");
  });

  it("drops findings GitLab says are resolved on the default branch", () => {
    expect(
      mapGitLabVulnerability({ ...DEPENDENCY, resolvedOnDefaultBranch: true }),
    ).toBeUndefined();
  });
});

describe("fetchGitLabVulnerabilities", () => {
  it("walks the group's report by cursor, asking only for open package/image findings", async () => {
    const { http, calls } = makeHttp((call: Call) => {
      const vars = (call.body as { variables: { after: string | null } }).variables;
      if (!vars.after) {
        return page({
          id: "gid://gitlab/Group/7",
          fullPath: "acme",
          userPermissions: { readSecurityResource: true },
          vulnerabilities: {
            nodes: [DEPENDENCY],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        });
      }
      return page({
        id: "gid://gitlab/Group/7",
        fullPath: "acme",
        userPermissions: { readSecurityResource: true },
        vulnerabilities: { nodes: [CONTAINER], pageInfo: { hasNextPage: false, endCursor: "c2" } },
      });
    });
    const findings = await fetchGitLabVulnerabilities(ctxWith(http), {
      groupPath: "acme",
      projects: [],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe("/api/graphql");
    const body = calls[0]!.body as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("scope: group(fullPath: $fullPath)");
    expect(body.query).toContain("state: [DETECTED, CONFIRMED]");
    expect(body.variables["reportType"]).toEqual([
      "DEPENDENCY_SCANNING",
      "CONTAINER_SCANNING",
      "CONTAINER_SCANNING_FOR_REGISTRY",
    ]);
    expect((calls[1]!.body as { variables: { after: string } }).variables.after).toBe("c1");
    expect(findings.map((f) => f.advisoryId)).toEqual(["CVE-2020-8203", "CVE-2023-4911"]);
  });

  it("reports a group without Ultimate (or below Developer) as an access gap, not as clean", async () => {
    const { http } = makeHttp(() =>
      page({
        id: "gid://gitlab/Group/7",
        fullPath: "acme",
        userPermissions: { readSecurityResource: false },
        vulnerabilities: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
    );
    const err = await fetchGitLabVulnerabilities(ctxWith(http), {
      groupPath: "acme",
      projects: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VulnerabilityAccessError);
    expect((err as Error).message).toMatch(/Ultimate/);
  });

  it("retries without the permission field on older instances and checks REST for a 403", async () => {
    const { http, calls } = makeHttp((call: Call) => {
      if (call.url.pathname === "/api/graphql") {
        const q = (call.body as { query: string }).query;
        if (q.includes("readSecurityResource")) {
          return {
            errors: [
              {
                message: "Field 'readSecurityResource' doesn't exist on type 'ProjectPermissions'",
              },
            ],
          };
        }
        return page({
          id: "gid://gitlab/Project/42",
          fullPath: "acme/web",
          vulnerabilities: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        });
      }
      return { status: 403, body: { message: "403 Forbidden" } };
    });
    const err = await fetchGitLabVulnerabilities(ctxWith(http), {
      projects: [{ id: 42, path_with_namespace: "acme/web" }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VulnerabilityAccessError);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/graphql",
      "/api/graphql",
      "/api/v4/projects/42/vulnerability_findings",
    ]);
  });

  it("reports Community Edition as a tier gap", async () => {
    const { http } = makeHttp(() => ({
      errors: [{ message: "Field 'vulnerabilities' doesn't exist on type 'Project'" }],
    }));
    const err = await fetchGitLabVulnerabilities(ctxWith(http), {
      projects: [{ id: 42, path_with_namespace: "acme/web" }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VulnerabilityAccessError);
  });

  it("skips projects without access when others are readable", async () => {
    const { http } = makeHttp((call: Call) => {
      const path = (call.body as { variables: { fullPath: string } }).variables.fullPath;
      if (path === "acme/free") {
        return page({
          id: "gid://gitlab/Project/43",
          fullPath: "acme/free",
          userPermissions: { readSecurityResource: false },
          vulnerabilities: { nodes: [], pageInfo: { hasNextPage: false } },
        });
      }
      return page({
        id: "gid://gitlab/Project/42",
        fullPath: "acme/web",
        userPermissions: { readSecurityResource: true },
        vulnerabilities: { nodes: [DEPENDENCY], pageInfo: { hasNextPage: false } },
      });
    });
    const findings = await fetchGitLabVulnerabilities(ctxWith(http), {
      projects: [
        { id: 42, path_with_namespace: "acme/web" },
        { id: 43, path_with_namespace: "acme/free" },
      ],
    });
    expect(findings).toHaveLength(1);
  });

  it("throws on a GraphQL error rather than returning a short list", async () => {
    const { http } = makeHttp(() => ({ errors: [{ message: "Timeout on vulnerabilities" }] }));
    await expect(
      fetchGitLabVulnerabilities(ctxWith(http), {
        projects: [{ id: 42, path_with_namespace: "acme/web" }],
      }),
    ).rejects.toThrow(/Timeout/);
  });
});

describe("manifest", () => {
  it("declares the capability and the client implements it", () => {
    expect(plugin.manifest.vulnerabilities?.partial).toBe(true);
    const client = plugin.createClient({ token: "t" });
    expect(typeof client.listVulnerabilityFindings).toBe("function");
  });
});
