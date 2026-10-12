import { describe, expect, it } from "vitest";
import {
  alertableVulnerabilityFindings,
  computeVulnerabilityFeed,
  describeRunning,
  filterVulnerabilityFindings,
  openVulnerabilitiesByResource,
  parseImageRef,
  vulnerabilityArtifactKey,
  type StoredVulnerabilityFinding,
  type VulnerabilityFeedInput,
} from "../vulnerabilities";

describe("parseImageRef", () => {
  it("canonicalises Docker Hub spellings", () => {
    expect(parseImageRef("nginx")).toEqual({ repository: "docker.io/library/nginx" });
    expect(parseImageRef("index.docker.io/library/nginx:1.27")).toEqual({
      repository: "docker.io/library/nginx",
      tag: "1.27",
    });
    expect(parseImageRef("acme/api:v2")).toEqual({ repository: "docker.io/acme/api", tag: "v2" });
  });

  it("keeps registry ports apart from tags and reads digests", () => {
    expect(parseImageRef("localhost:5000/app:dev")).toEqual({
      repository: "localhost:5000/app",
      tag: "dev",
    });
    expect(parseImageRef("docker-pullable://ghcr.io/Acme/API@sha256:ABC")).toEqual({
      repository: "ghcr.io/acme/api",
      digest: "sha256:abc",
    });
    expect(parseImageRef("sha256:abc")).toEqual({ repository: "", digest: "sha256:abc" });
    expect(parseImageRef("  ")).toBeNull();
  });

  it("keys artifacts by repository so rebuilds share a dismissal", () => {
    expect(vulnerabilityArtifactKey({ kind: "image", name: "nginx" })).toBe(
      "image:docker.io/library/nginx",
    );
    expect(vulnerabilityArtifactKey({ kind: "repository", name: "Acme/API" })).toBe(
      "repository:acme/api",
    );
  });
});

const ECR = "123456789012.dkr.ecr.us-east-1.amazonaws.com/api";

function stored(over: Partial<StoredVulnerabilityFinding> = {}): StoredVulnerabilityFinding {
  return {
    accountId: "aws1",
    pluginId: "aws",
    findingId: "f1",
    advisoryId: "CVE-2024-0001",
    aliases: [],
    title: "bad thing",
    severity: "critical",
    cvssScore: 9.8,
    cvssVector: null,
    packageName: "openssl",
    packageEcosystem: "os",
    installedVersion: "3.0.1",
    fixedVersion: "3.0.2",
    fixAvailable: true,
    exploitAvailable: null,
    artifactKind: "image",
    artifactName: ECR,
    artifactDigest: "sha256:aaa",
    artifactTags: ["v1"],
    artifactResourceId: null,
    artifactUrl: null,
    firstSeenAt: null,
    lastSeenAt: null,
    url: null,
    collectedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function input(over: Partial<VulnerabilityFeedInput> = {}): VulnerabilityFeedInput {
  return {
    plugins: [
      {
        id: "aws",
        displayName: "AWS",
        vulnerabilities: { label: "Amazon Inspector" },
        resourceTypes: [
          {
            id: "lambda-function",
            displayName: "Lambda Function",
            pluralDisplayName: "Lambda Functions",
          },
        ],
      },
      {
        id: "kubernetes",
        displayName: "Kubernetes",
        resourceTypes: [
          {
            id: "k8s-pod",
            displayName: "Pod",
            pluralDisplayName: "Pods",
            runningImages: {
              imageKeys: ["images"],
              digestKeys: ["imageDigests"],
              runningKey: "status",
              runningValues: ["Running"],
            },
          },
        ],
      },
    ],
    accounts: [
      { id: "aws1", displayName: "Prod AWS", pluginId: "aws" },
      { id: "k1", displayName: "Prod cluster", pluginId: "kubernetes" },
    ],
    resources: [
      pod("p1", { images: `${ECR}:v1`, imageDigests: `${ECR}@sha256:aaa`, status: "Running" }),
      pod("p2", { images: `${ECR}:v1`, imageDigests: "", status: "Running" }),
      pod("p3", { images: `${ECR}:v1`, imageDigests: `${ECR}@sha256:bbb`, status: "Running" }),
      pod("p4", { images: `${ECR}:v1`, imageDigests: `${ECR}@sha256:aaa`, status: "Succeeded" }),
      {
        id: "aws1:lambda:fn",
        pluginId: "aws",
        resourceTypeId: "lambda-function",
        accountId: "aws1",
        displayName: "fn",
        externalId: "arn:aws:lambda:us-east-1:123456789012:function:fn",
        fields: {},
      },
    ],
    findings: [stored()],
    now: Date.parse("2026-10-02T00:00:00Z"),
    ...over,
  };
}

function pod(id: string, fields: Record<string, string>) {
  return {
    id,
    pluginId: "kubernetes",
    resourceTypeId: "k8s-pod",
    accountId: "k1",
    displayName: id,
    externalId: null,
    fields,
  };
}

describe("computeVulnerabilityFeed", () => {
  it("joins by digest, falls back to tag only without a digest, and skips stopped pods", () => {
    const feed = computeVulnerabilityFeed(input());
    const running = feed.findings[0]!.running;
    // p1: digest match. p2: tag match, no digest known. p3 runs a different
    // digest of the same tag (the tag moved), p4 is not running.
    expect(running.map((r) => [r.resourceId, r.matchedBy])).toEqual([
      ["p1", "digest"],
      ["p2", "tag"],
    ]);
    expect(feed.runningCounts.critical).toBe(1);
    expect(describeRunning(running)).toBe("2 Pods");
  });

  it("joins a finding that names a resource by its external id", () => {
    const feed = computeVulnerabilityFeed(
      input({
        findings: [
          stored({
            artifactKind: "function",
            artifactName: "fn",
            artifactDigest: null,
            artifactTags: [],
            artifactResourceId: "arn:aws:lambda:us-east-1:123456789012:function:fn",
          }),
        ],
      }),
    );
    expect(feed.findings[0]!.running.map((r) => r.matchedBy)).toEqual(["resource"]);
  });

  it("partitions dismissals, including advisory-wide ones", () => {
    const feed = computeVulnerabilityFeed(
      input({
        findings: [stored(), stored({ findingId: "f2", artifactName: "ghcr.io/acme/other" })],
        dismissals: [
          {
            advisoryId: "cve-2024-0001",
            artifactKey: `image:${ECR}`,
            dismissedAt: "2026-10-01T00:00:00Z",
            dismissedBy: "a",
            reason: null,
          },
        ],
      }),
    );
    expect(feed.findings.map((f) => f.findingId)).toEqual(["f2"]);
    expect(feed.dismissedCount).toBe(1);
    const all = computeVulnerabilityFeed(
      input({
        dismissals: [
          {
            advisoryId: "CVE-2024-0001",
            artifactKey: "*",
            dismissedAt: "2026-10-01T00:00:00Z",
            dismissedBy: null,
            reason: "not reachable",
          },
        ],
      }),
    );
    expect(all.totalCount).toBe(0);
  });

  it("marks KEV through aliases and sorts running and KEV first within a severity", () => {
    const feed = computeVulnerabilityFeed(
      input({
        findings: [
          stored({
            findingId: "a",
            advisoryId: "GHSA-1",
            aliases: ["CVE-2021-44228"],
            artifactName: "x/y",
            artifactDigest: null,
          }),
          stored({ findingId: "b" }),
          stored({ findingId: "c", artifactName: "x/z", artifactDigest: null, cvssScore: 10 }),
        ],
        kev: new Map([
          ["CVE-2021-44228", { dateAdded: "2021-12-10", dueDate: null, knownRansomware: true }],
        ]),
      }),
    );
    expect(feed.findings.map((f) => f.findingId)).toEqual(["b", "a", "c"]);
    expect(feed.findings[1]!.kev?.knownRansomware).toBe(true);
    expect(filterVulnerabilityFindings(feed.findings, { kev: true })).toHaveLength(1);
    expect(filterVulnerabilityFindings(feed.findings, { running: false })).toHaveLength(2);
  });

  it("summarises open findings per resource and picks alertable ones", () => {
    const feed = computeVulnerabilityFeed(
      input({
        findings: [stored(), stored({ findingId: "lo", severity: "low", advisoryId: "CVE-1" })],
      }),
    );
    const byResource = openVulnerabilitiesByResource(feed);
    expect(byResource.get("p1")).toMatchObject({ critical: 1, advisories: ["CVE-2024-0001"] });
    expect(
      alertableVulnerabilityFindings(feed, { minSeverity: "critical", runningOnly: true }),
    ).toHaveLength(1);
  });
});
