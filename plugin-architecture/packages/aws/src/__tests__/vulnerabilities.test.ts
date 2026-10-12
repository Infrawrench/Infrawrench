import { describe, expect, it, vi } from "vitest";
import { VulnerabilityAccessError } from "@infrawrench/plugin-base";
import {
  artifactFor,
  fetchAwsVulnerabilityFindings,
  listFindingsBody,
  mapInspectorFinding,
  MAX_PAGES_PER_REGION,
  type AwsVulnerabilityContext,
  type InspectorFinding,
  type InspectorListFindingsResponse,
} from "../vulnerabilities.js";

/**
 * Fixtures follow the `ListFindings` response syntax in the API reference
 * (https://docs.aws.amazon.com/inspector/v2/APIReference/API_ListFindings.html)
 * and the `Finding` / `Resource` / `VulnerablePackage` shapes linked from it.
 * Timestamps are epoch seconds, as REST-JSON serialises them.
 */
// Recorded wire shape, so it carries fields the module does not decode.
const ECR_FINDING = {
  awsAccountId: "123456789012",
  description: "A flaw was found in OpenSSL.",
  findingArn: "arn:aws:inspector2:us-east-1:123456789012:finding/0123456789abcdef0123456789abcdef",
  firstObservedAt: 1_760_000_000,
  lastObservedAt: 1_760_086_400,
  updatedAt: 1_760_086_400,
  fixAvailable: "YES",
  exploitAvailable: "NO",
  inspectorScore: 7.5,
  inspectorScoreDetails: {
    adjustedCvss: {
      score: 7.5,
      scoringVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
    },
  },
  packageVulnerabilityDetails: {
    vulnerabilityId: "CVE-2024-0727",
    source: "DEBIAN_CVE",
    sourceUrl: "https://security-tracker.debian.org/tracker/CVE-2024-0727",
    relatedVulnerabilities: [],
    cvss: [{ baseScore: 5.5, scoringVector: "CVSS:3.1/AV:L", source: "NVD", version: "3.1" }],
    vulnerablePackages: [
      {
        name: "openssl",
        version: "3.0.11",
        release: "1~deb12u2",
        arch: "AMD64",
        epoch: 0,
        fixedInVersion: "0:3.0.13-1~deb12u1",
        packageManager: "OS",
      },
    ],
  },
  remediation: { recommendation: { text: "None Provided" } },
  resources: [
    {
      id: "arn:aws:ecr:us-east-1:123456789012:repository/api/sha256:abc",
      type: "AWS_ECR_CONTAINER_IMAGE",
      partition: "aws",
      region: "us-east-1",
      details: {
        awsEcrContainerImage: {
          registry: "123456789012",
          repositoryName: "api",
          imageHash: "sha256:ABCDEF0123",
          imageTags: ["v1.2.3", "latest"],
          architecture: "amd64",
          pushedAt: 1_759_000_000,
          inUseCount: 3,
          lastInUseAt: 1_760_000_000,
        },
      },
    },
  ],
  severity: "HIGH",
  status: "ACTIVE",
  title: "CVE-2024-0727 - openssl",
  type: "PACKAGE_VULNERABILITY",
} as unknown as InspectorFinding;

const LAMBDA_FINDING: InspectorFinding = {
  findingArn: "arn:aws:inspector2:eu-west-1:123456789012:finding/11111111111111111111111111111111",
  firstObservedAt: 1_760_000_000,
  lastObservedAt: 1_760_000_000,
  fixAvailable: "PARTIAL",
  exploitAvailable: "YES",
  inspectorScore: 9.8,
  packageVulnerabilityDetails: {
    vulnerabilityId: "GHSA-xxxx-yyyy-zzzz",
    relatedVulnerabilities: ["CVE-2023-1111"],
    vulnerablePackages: [
      { name: "lodash", version: "4.17.15", fixedInVersion: "4.17.21", packageManager: "NPM" },
      { name: "minimist", version: "1.2.0", fixedInVersion: "NotAvailable", packageManager: "NPM" },
    ],
  },
  resources: [
    {
      id: "arn:aws:lambda:eu-west-1:123456789012:function:checkout:$LATEST",
      type: "AWS_LAMBDA_FUNCTION",
      region: "eu-west-1",
      details: { awsLambdaFunction: { functionName: "checkout" } },
    },
  ],
  severity: "CRITICAL",
  status: "ACTIVE",
  title: "GHSA-xxxx-yyyy-zzzz - lodash, minimist",
  type: "PACKAGE_VULNERABILITY",
};

const EC2_FINDING: InspectorFinding = {
  findingArn: "arn:aws:inspector2:us-east-1:123456789012:finding/22222222222222222222222222222222",
  fixAvailable: "NO",
  packageVulnerabilityDetails: {
    vulnerabilityId: "cve-2023-4911",
    vulnerablePackages: [{ name: "glibc", version: "2.26", packageManager: "OS" }],
  },
  resources: [{ id: "i-0abc123", type: "AWS_EC2_INSTANCE", region: "us-east-1" }],
  severity: "UNTRIAGED",
  status: "ACTIVE",
  type: "PACKAGE_VULNERABILITY",
};

function ctxWith(
  pages: Record<string, InspectorListFindingsResponse[] | Error>,
): AwsVulnerabilityContext & { listFindings: ReturnType<typeof vi.fn> } {
  const cursor: Record<string, number> = {};
  return {
    regions: Object.keys(pages),
    listFindings: vi.fn(async (region: string) => {
      const p = pages[region]!;
      if (p instanceof Error) throw p;
      const i = cursor[region] ?? 0;
      cursor[region] = i + 1;
      return p[i] ?? { findings: [] };
    }),
  };
}

describe("listFindingsBody", () => {
  it("filters to active package findings, most severe first", () => {
    expect(listFindingsBody()).toEqual({
      filterCriteria: {
        findingStatus: [{ comparison: "EQUALS", value: "ACTIVE" }],
        findingType: [{ comparison: "EQUALS", value: "PACKAGE_VULNERABILITY" }],
      },
      maxResults: 100,
      sortCriteria: { field: "SEVERITY", sortOrder: "DESC" },
    });
    expect(listFindingsBody("tok")).toMatchObject({ nextToken: "tok" });
  });
});

describe("mapInspectorFinding", () => {
  it("maps an ECR image finding to a pullable image reference and digest", () => {
    const [f] = mapInspectorFinding(ECR_FINDING, "us-east-1");
    expect(f).toMatchObject({
      id: ECR_FINDING.findingArn,
      advisoryId: "CVE-2024-0727",
      severity: "high",
      cvssScore: 7.5,
      cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
      packageName: "openssl",
      packageEcosystem: "os",
      installedVersion: "3.0.11-1~deb12u2",
      fixedVersion: "0:3.0.13-1~deb12u1",
      fixAvailable: true,
      exploitAvailable: false,
      firstSeenAt: new Date(1_760_000_000_000).toISOString(),
      url: "https://security-tracker.debian.org/tracker/CVE-2024-0727",
      artifact: {
        kind: "image",
        name: "123456789012.dkr.ecr.us-east-1.amazonaws.com/api",
        digest: "sha256:ABCDEF0123",
        tags: ["v1.2.3", "latest"],
      },
    });
    expect(f!.aliases).toBeUndefined();
  });

  it("splits a multi-package finding and keeps PARTIAL fixes per package", () => {
    const out = mapInspectorFinding(LAMBDA_FINDING, "eu-west-1");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: `${LAMBDA_FINDING.findingArn}#lodash@4.17.15`,
      severity: "critical",
      packageName: "lodash",
      packageEcosystem: "npm",
      fixedVersion: "4.17.21",
      fixAvailable: true,
      exploitAvailable: true,
      aliases: ["CVE-2023-1111"],
      artifact: { kind: "function", name: "checkout", resourceExternalId: "checkout" },
    });
    // "NotAvailable" is no version; PARTIAL says nothing about this package.
    expect(out[1]!.fixedVersion).toBeUndefined();
    expect(out[1]!.fixAvailable).toBeUndefined();
  });

  it("maps an EC2 finding to the instance id and leaves an untriaged severity unknown", () => {
    const [f] = mapInspectorFinding(EC2_FINDING, "us-east-1");
    expect(f).toMatchObject({
      id: EC2_FINDING.findingArn,
      severity: "unknown",
      fixAvailable: false,
      artifact: { kind: "host", name: "i-0abc123", resourceExternalId: "i-0abc123" },
    });
  });

  it("skips network reachability and code findings", () => {
    expect(
      mapInspectorFinding({ ...ECR_FINDING, type: "NETWORK_REACHABILITY" }, "us-east-1"),
    ).toEqual([]);
    expect(
      mapInspectorFinding({ ...ECR_FINDING, type: "CODE_VULNERABILITY" }, "us-east-1"),
    ).toEqual([]);
  });

  it("derives a Lambda name from a qualified ARN when details are absent", () => {
    expect(
      artifactFor(
        {
          id: "arn:aws:lambda:us-east-1:123456789012:function:fn:$LATEST",
          type: "AWS_LAMBDA_FUNCTION",
        },
        "us-east-1",
      ),
    ).toMatchObject({ name: "fn", resourceExternalId: "fn" });
  });

  it("uses the China partition host for ECR", () => {
    expect(
      artifactFor(
        {
          type: "AWS_ECR_CONTAINER_IMAGE",
          region: "cn-north-1",
          partition: "aws-cn",
          details: { awsEcrContainerImage: { registry: "111122223333", repositoryName: "x/y" } },
        },
        "cn-north-1",
      )?.name,
    ).toBe("111122223333.dkr.ecr.cn-north-1.amazonaws.com.cn/x/y");
  });
});

describe("fetchAwsVulnerabilityFindings", () => {
  it("pages each region and normalises the result", async () => {
    const ctx = ctxWith({
      "us-east-1": [{ findings: [ECR_FINDING], nextToken: "p2" }, { findings: [EC2_FINDING] }],
      "eu-west-1": [{ findings: [LAMBDA_FINDING] }],
    });
    const out = await fetchAwsVulnerabilityFindings(ctx);
    expect(out).toHaveLength(4);
    expect(out.find((f) => f.artifact.kind === "image")!.artifact.digest).toBe("sha256:abcdef0123");
    expect(out.find((f) => f.artifact.kind === "host")!.advisoryId).toBe("CVE-2023-4911");
    expect(ctx.listFindings).toHaveBeenCalledTimes(3);
    expect(
      ctx.listFindings.mock.calls.some(
        ([region, body]) => region === "us-east-1" && body.nextToken === "p2",
      ),
    ).toBe(true);
  });

  it("stops at the page bound", async () => {
    const ctx: AwsVulnerabilityContext = {
      regions: ["us-east-1"],
      listFindings: vi.fn(async () => ({ findings: [], nextToken: "again" })),
    };
    await fetchAwsVulnerabilityFindings(ctx);
    expect(ctx.listFindings).toHaveBeenCalledTimes(MAX_PAGES_PER_REGION);
  });

  it("throws an access error when the identity lacks inspector2:ListFindings", async () => {
    const ctx = ctxWith({
      "us-east-1": new Error(
        'AWS inspector2 POST /findings/list failed: 403: {"message":"User: arn:aws:iam::123456789012:user/x is not authorized to perform: inspector2:ListFindings"}',
      ),
    });
    await expect(fetchAwsVulnerabilityFindings(ctx)).rejects.toBeInstanceOf(
      VulnerabilityAccessError,
    );
  });

  it("skips a refused region when another answers", async () => {
    const ctx = ctxWith({
      "us-east-1": [{ findings: [EC2_FINDING] }],
      "ap-east-1": new Error(
        "AWS inspector2 POST /findings/list failed: 403: User is not authorized to perform: inspector2:ListFindings with an explicit deny in a service control policy",
      ),
    });
    expect(await fetchAwsVulnerabilityFindings(ctx)).toHaveLength(1);
  });

  it("throws an access error when every region refuses", async () => {
    const ctx = ctxWith({
      "us-east-1": new Error(
        'AWS inspector2 POST /findings/list failed: 403: {"__type":"AccessDeniedException"}',
      ),
    });
    await expect(fetchAwsVulnerabilityFindings(ctx)).rejects.toBeInstanceOf(
      VulnerabilityAccessError,
    );
  });

  it("fails the whole read on a transient error rather than returning a short list", async () => {
    const ctx = ctxWith({
      "us-east-1": [{ findings: [EC2_FINDING] }],
      "eu-west-1": new Error(
        "AWS inspector2 POST /findings/list failed: 500: InternalServerException",
      ),
    });
    await expect(fetchAwsVulnerabilityFindings(ctx)).rejects.toThrow(/500/);
  });

  it("does not treat an expired credential as a refused region", async () => {
    const ctx = ctxWith({
      "us-east-1": new Error(
        "AWS inspector2 POST /findings/list failed: 403: ExpiredTokenException",
      ),
    });
    await expect(fetchAwsVulnerabilityFindings(ctx)).rejects.toThrow(/ExpiredToken/);
  });
});
