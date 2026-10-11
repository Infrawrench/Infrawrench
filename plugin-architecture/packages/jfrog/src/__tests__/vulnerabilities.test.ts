/**
 * Xray vulnerability findings. Response shapes follow the JFrog docs:
 * - Artifact Summary v2: https://docs.jfrog.com/security/reference/artifact-summary_artifacts-v2-openapi
 * - Artifact Summary v1: https://docs.jfrog.com/security/reference/artifact-summary
 * - AQL: https://docs.jfrog.com/artifactory/docs/aql-query-execution
 * - Repository configurations: GET /artifactory/api/repositories/configurations
 */
import { VulnerabilityAccessError } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { JfrogClient } from "../client.js";
import { plugin } from "../plugin.js";
import { aqlFor, parseComponentId, parseCvss, targetFor } from "../vulnerabilities.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const creds = { baseUrl: "https://acme.jfrog.io", accessToken: "tok" };
const DIGEST = "a".repeat(64);
const NPM_SHA = "8240b88c4879b771bdc2ab571fe26d8c10dc92f0e1c130ae468a01ef0d57fe52";

const REPOS = [
  { key: "docker-local", type: "LOCAL", packageType: "Docker" },
  { key: "npm-local", type: "LOCAL", packageType: "Npm" },
  { key: "dockerhub", type: "REMOTE", packageType: "Docker" },
  { key: "not-indexed", type: "LOCAL", packageType: "Npm" },
  { key: "npm-virtual", type: "VIRTUAL", packageType: "Npm" },
];

const CONFIGS = {
  LOCAL: [
    { key: "docker-local", rclass: "local", packageType: "docker", xrayIndex: true },
    { key: "npm-local", rclass: "local", packageType: "npm", xrayIndex: true },
    { key: "not-indexed", rclass: "local", packageType: "npm", xrayIndex: false },
  ],
  REMOTE: [{ key: "dockerhub", rclass: "remote", packageType: "docker", xrayIndex: true }],
  VIRTUAL: [{ key: "npm-virtual", rclass: "virtual", packageType: "npm", xrayIndex: true }],
};

const AQL: Record<string, unknown> = {
  "docker-local": {
    results: [
      {
        repo: "docker-local",
        path: "team/api/1.4.0",
        name: "manifest.json",
        sha256: DIGEST.toUpperCase(),
        modified: "2026-10-01T10:00:00.000Z",
      },
    ],
    range: { start_pos: 0, end_pos: 1, total: 1, limit: 50 },
  },
  "npm-local": {
    results: [{ repo: "npm-local", path: ".", name: "moment-2.29.3.tgz", sha256: NPM_SHA }],
    range: { start_pos: 0, end_pos: 1, total: 1, limit: 50 },
  },
  "dockerhub-cache": {
    results: [
      {
        repo: "dockerhub-cache",
        path: `library/nginx/sha256__${"b".repeat(64)}`,
        name: "manifest.json",
        sha256: "c".repeat(64),
      },
    ],
    range: { start_pos: 0, end_pos: 1, total: 1, limit: 50 },
  },
};

const SUMMARY_V2 = {
  artifacts: [
    {
      general: {
        name: "team/api:1.4.0",
        component_id: "team/api:1.4.0",
        pkg_type: "Docker",
        path: "default/docker-local/team/api/1.4.0/manifest.json",
        sha256: DIGEST,
      },
      issues: [
        {
          issue_id: "XRAY-264729",
          summary: "OpenSSL buffer overflow",
          issue_type: "security",
          severity: "Critical",
          provider: "JFrog",
          cves: [
            { cve: "CVE-2022-3602", cvss_v3: "9.8/CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
            { cve: "CVE-2022-3786" },
          ],
          created: "2022-11-01T00:00:00.000Z",
          components: [
            {
              component_id: "deb://debian:bookworm:openssl:3.0.5-1",
              version: "3.0.5-1",
              pkg_type: "Debian",
              fixed_versions: ["3.0.7-1"],
            },
            {
              component_id: "deb://debian:bookworm:libssl3:3.0.5-1",
              version: "3.0.5-1",
              pkg_type: "Debian",
              fixed_versions: [],
            },
          ],
        },
        {
          issue_id: "XRAY-1",
          summary: "license thing",
          issue_type: "license",
          severity: "High",
        },
      ],
    },
    {
      general: {
        name: "moment-2.29.3.tgz",
        component_id: "moment-2.29.3.tgz",
        pkg_type: "Npm",
        path: "default/npm-local/moment-2.29.3.tgz",
        sha256: NPM_SHA,
      },
      issues: [
        {
          issue_id: "XRAY-230778",
          summary: "moment is a JavaScript date library for parsing...",
          issue_type: "security",
          severity: "High",
          provider: "JFrog",
          cves: [
            {
              cve: "CVE-2022-31129",
              cwe: ["CWE-1333", "CWE-400"],
              cvss_v2: "5.0/CVSS:2.0/AV:N/C:N/I:N/A:P",
              cvss_v3: "7.5/CVSS:3.1/AV:N/PR:N/UI:N/S:U/C:N/I:N/A:H",
            },
          ],
          created: "2022-07-12T00:00:08.828Z",
          impact_path: ["default/npm-local/moment-2.29.3.tgz/moment-2.29.3/package.json"],
          components: [
            {
              component_id: "npm://moment:2.29.3",
              version: "2.29.3",
              pkg_type: "npm",
              fixed_versions: ["2.29.4"],
            },
          ],
        },
      ],
    },
  ],
  errors: [
    {
      identifier: `default/dockerhub-cache/library/nginx/sha256__${"b".repeat(64)}/manifest.json`,
      error: "Artifact doesn't exist or not indexed/cached in Xray",
    },
  ],
};

function client(route: (call: Call) => unknown) {
  const { http, calls } = makeHttp(route);
  return { c: new JfrogClient(creds, { http } as never), calls };
}

function baseRoute(call: Call): unknown {
  const p = call.url.pathname;
  if (p === "/artifactory/api/repositories") return REPOS;
  if (p === "/artifactory/api/repositories/configurations") return CONFIGS;
  if (p === "/artifactory/api/search/aql") {
    const m = /"repo":"([^"]+)"/.exec(String(call.body));
    return AQL[m?.[1] ?? ""] ?? { results: [] };
  }
  return undefined;
}

describe("JFrog Xray vulnerability findings", () => {
  it("declares the capability", () => {
    expect(plugin.manifest.vulnerabilities).toMatchObject({ label: "JFrog Xray", partial: true });
  });

  it("parses CVSS and component ids", () => {
    expect(parseCvss("7.5/CVSS:3.1/AV:N")).toEqual({ score: 7.5, vector: "CVSS:3.1/AV:N" });
    expect(parseCvss(undefined)).toEqual({});
    expect(parseComponentId("npm://moment:2.29.3")).toEqual({
      ecosystem: "npm",
      name: "moment",
      version: "2.29.3",
    });
    expect(parseComponentId("gav://org.apache:commons:1.2")).toEqual({
      ecosystem: "maven",
      name: "org.apache:commons",
      version: "1.2",
    });
  });

  it("builds a non-admin-safe AQL query", () => {
    const q = aqlFor("npm-local", ["*.tgz"], 50);
    expect(q).toContain('"repo":"npm-local"');
    expect(q).toContain('{"$match":"*.tgz"}');
    expect(q).toContain('.include("repo","path","name","sha256","modified")');
    expect(q).toContain(".limit(50)");
  });

  it("names Docker images the way they are pulled", () => {
    const t = targetFor(
      "https://acme.jfrog.io",
      { key: "docker-local", rclass: "local", packageType: "docker", xrayIndex: true },
      { repo: "docker-local", path: "team/api/1.4.0", name: "manifest.json", sha256: DIGEST },
    );
    expect(t?.artifact).toMatchObject({
      kind: "image",
      name: "acme.jfrog.io/docker-local/team/api",
      digest: `sha256:${DIGEST}`,
      tags: ["1.4.0"],
    });
    expect(t?.xrayPath).toBe("default/docker-local/team/api/1.4.0/manifest.json");
  });

  it("reads indexed repositories and maps the summary", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/xray/api/v2/summary/artifact") return SUMMARY_V2;
      return baseRoute(call);
    });
    const findings = await c.listVulnerabilityFindings("acct");

    const aqlRepos = calls
      .filter((x) => x.url.pathname === "/artifactory/api/search/aql")
      .map((x) => /"repo":"([^"]+)"/.exec(String(x.body))?.[1]);
    expect(aqlRepos).toEqual(["docker-local", "npm-local", "dockerhub-cache"]);
    const aqlCall = calls.find((x) => x.url.pathname === "/artifactory/api/search/aql");
    expect(aqlCall?.headers["Content-Type"]).toBe("text/plain");
    const summary = calls.find((x) => x.url.pathname === "/xray/api/v2/summary/artifact");
    expect(summary?.method).toBe("POST");
    expect((summary?.body as { paths: string[] }).paths).toHaveLength(3);

    expect(findings).toHaveLength(3);
    const openssl = findings.find((f) => f.packageName === "debian:bookworm:openssl");
    expect(openssl).toMatchObject({
      advisoryId: "CVE-2022-3602",
      aliases: ["CVE-2022-3786", "XRAY-264729"],
      severity: "critical",
      cvssScore: 9.8,
      cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      packageEcosystem: "deb",
      installedVersion: "3.0.5-1",
      fixedVersion: "3.0.7-1",
      fixAvailable: true,
      artifact: {
        kind: "image",
        name: "acme.jfrog.io/docker-local/team/api",
        digest: `sha256:${DIGEST}`,
        tags: ["1.4.0"],
      },
    });
    const libssl = findings.find((f) => f.packageName === "debian:bookworm:libssl3");
    expect(libssl?.fixAvailable).toBeUndefined();
    expect(libssl?.fixedVersion).toBeUndefined();

    const moment = findings.find((f) => f.packageName === "moment");
    expect(moment).toMatchObject({
      advisoryId: "CVE-2022-31129",
      severity: "high",
      cvssScore: 7.5,
      packageEcosystem: "npm",
      fixedVersion: "2.29.4",
      artifact: { kind: "package", name: "npm-local/moment-2.29.3.tgz" },
    });
    expect(findings.every((f) => f.advisoryId !== "XRAY-1")).toBe(true);
    expect(new Set(findings.map((f) => f.id)).size).toBe(3);
  });

  it("falls back to the v1 summary on an older Xray", async () => {
    const v1 = {
      artifacts: [
        {
          ...SUMMARY_V2.artifacts[1],
          issues: SUMMARY_V2.artifacts[1]!.issues.map(({ components: _c, ...rest }) => rest),
        },
      ],
      errors: [],
    };
    const { c } = client((call) => {
      if (call.url.pathname === "/xray/api/v2/summary/artifact") {
        return { status: 404, body: { error: "not found" } };
      }
      if (call.url.pathname === "/xray/api/v1/summary/artifact") return v1;
      return baseRoute(call);
    });
    const findings = await c.listVulnerabilityFindings("acct");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ advisoryId: "CVE-2022-31129", severity: "high" });
    expect(findings[0]!.packageName).toBeUndefined();
  });

  it("raises an access error when Xray is absent or refuses the token", async () => {
    const absent = client((call) => {
      if (call.url.pathname.startsWith("/xray/")) return { status: 404, text: "Not Found" };
      return baseRoute(call);
    });
    await expect(absent.c.listVulnerabilityFindings("acct")).rejects.toBeInstanceOf(
      VulnerabilityAccessError,
    );

    const refused = client((call) => {
      if (call.url.pathname.startsWith("/xray/"))
        return { status: 403, body: { error: "Forbidden" } };
      return baseRoute(call);
    });
    await expect(refused.c.listVulnerabilityFindings("acct")).rejects.toBeInstanceOf(
      VulnerabilityAccessError,
    );
  });

  it("rethrows transient failures instead of returning a short list", async () => {
    const { c } = client((call) => {
      if (call.url.pathname.startsWith("/xray/")) return { status: 500, body: { error: "boom" } };
      return baseRoute(call);
    });
    await expect(c.listVulnerabilityFindings("acct")).rejects.not.toBeInstanceOf(
      VulnerabilityAccessError,
    );
  });
});
