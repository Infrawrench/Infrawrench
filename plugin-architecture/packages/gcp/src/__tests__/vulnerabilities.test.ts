import { describe, expect, it, vi } from "vitest";
import { VulnerabilityAccessError } from "@infrawrench/plugin-base";
import {
  MAX_OCCURRENCE_PAGES,
  artifactFromResourceUri,
  fetchGcpVulnerabilityFindings,
  occurrenceToFindings,
  versionString,
  type GcpOccurrence,
  type GcpOccurrenceList,
} from "../vulnerabilities.js";
import { CloudRunServiceResourceType } from "../resources/cloud-run-service.js";
import { CloudRunJobResourceType } from "../resources/cloud-run-job.js";
import { cloudRunContainerImages } from "../resource-listers/serverless.js";

/**
 * Shaped after the `Occurrence` / `VulnerabilityOccurrence` / `PackageIssue` /
 * `Version` schemas in the Container Analysis v1 discovery document
 * (https://containeranalysis.googleapis.com/$discovery/rest?version=v1) and
 * https://docs.cloud.google.com/artifact-analysis/docs/reference/rest/v1/projects.occurrences
 */
const OPENSSL: GcpOccurrence = {
  name: "projects/my-project/occurrences/0a1b2c3d-1111",
  resourceUri:
    "https://us-docker.pkg.dev/my-project/apps/api@sha256:ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  noteName: "projects/goog-vulnz/notes/CVE-2024-5535",
  kind: "VULNERABILITY",
  createTime: "2026-09-01T10:00:00.000000Z",
  updateTime: "2026-10-10T08:30:00.000000Z",
  vulnerability: {
    severity: "MEDIUM",
    effectiveSeverity: "HIGH",
    cvssScore: 9.1,
    cvssVersion: "CVSS_VERSION_3",
    shortDescription: "CVE-2024-5535",
    fixAvailable: true,
    relatedUrls: [
      { url: "https://security-tracker.debian.org/tracker/CVE-2024-5535", label: "More Info" },
    ],
    risk: { cisaKev: { knownRansomwareCampaignUse: "Unknown" } },
    packageIssue: [
      {
        affectedCpeUri: "cpe:/o:debian:debian_linux:12",
        affectedPackage: "openssl",
        affectedVersion: {
          name: "3.0.11",
          revision: "1~deb12u2",
          kind: "NORMAL",
          fullName: "3.0.11-1~deb12u2",
        },
        fixedCpeUri: "cpe:/o:debian:debian_linux:12",
        fixedPackage: "openssl",
        fixedVersion: {
          name: "3.0.13",
          revision: "1~deb12u1",
          kind: "NORMAL",
          fullName: "3.0.13-1~deb12u1",
        },
        fixAvailable: true,
        packageType: "OS",
        effectiveSeverity: "HIGH",
      },
    ],
  },
};

const NO_FIX: GcpOccurrence = {
  name: "projects/my-project/occurrences/0a1b2c3d-2222",
  resourceUri:
    "https://gcr.io/my-project/worker@sha256:1111111111111111111111111111111111111111111111111111111111111111",
  noteName: "projects/goog-vulnz/notes/CVE-2023-4911",
  kind: "VULNERABILITY",
  vulnerability: {
    severity: "SEVERITY_UNSPECIFIED",
    effectiveSeverity: "SEVERITY_UNSPECIFIED",
    cvssScore: 0,
    packageIssue: [
      {
        affectedPackage: "glibc",
        affectedVersion: { name: "2.36", revision: "9", kind: "NORMAL" },
        fixedVersion: { kind: "MAXIMUM" },
        packageType: "OS",
      },
      {
        affectedPackage: "libc-bin",
        affectedVersion: { name: "2.36", revision: "9", kind: "NORMAL" },
        fixedVersion: { kind: "MAXIMUM" },
        packageType: "OS",
      },
    ],
  },
};

describe("artifactFromResourceUri", () => {
  it("splits an image URI into the pullable repository and digest", () => {
    expect(
      artifactFromResourceUri("https://europe-west1-docker.pkg.dev/p/repo/team/img@sha256:abc"),
    ).toEqual({
      kind: "image",
      name: "europe-west1-docker.pkg.dev/p/repo/team/img",
      digest: "sha256:abc",
    });
  });

  it("treats a digest-less URI as a package", () => {
    expect(artifactFromResourceUri("https://us-maven.pkg.dev/p/repo/com.example:lib:1.0")).toEqual({
      kind: "package",
      name: "us-maven.pkg.dev/p/repo/com.example:lib:1.0",
    });
  });
});

describe("versionString", () => {
  it("prefers fullName, assembles name-revision otherwise, hides sentinels", () => {
    expect(versionString({ kind: "NORMAL", fullName: "1.2-3", name: "1.2" })).toBe("1.2-3");
    expect(versionString({ kind: "NORMAL", name: "2.36", revision: "9", epoch: 1 })).toBe(
      "1:2.36-9",
    );
    expect(versionString({ kind: "MAXIMUM" })).toBeUndefined();
  });
});

describe("occurrenceToFindings", () => {
  it("maps every documented field", () => {
    expect(occurrenceToFindings(OPENSSL)).toEqual([
      {
        id: "projects/my-project/occurrences/0a1b2c3d-1111",
        advisoryId: "CVE-2024-5535",
        title: "CVE-2024-5535",
        severity: "high",
        cvssScore: 9.1,
        exploitAvailable: true,
        packageName: "openssl",
        packageEcosystem: "os",
        installedVersion: "3.0.11-1~deb12u2",
        fixedVersion: "3.0.13-1~deb12u1",
        fixAvailable: true,
        artifact: {
          kind: "image",
          name: "us-docker.pkg.dev/my-project/apps/api",
          digest: "sha256:ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
        firstSeenAt: "2026-09-01T10:00:00.000000Z",
        lastSeenAt: "2026-10-10T08:30:00.000000Z",
        url: "https://security-tracker.debian.org/tracker/CVE-2024-5535",
      },
    ]);
  });

  it("emits one finding per package, MAXIMUM fixed version as no fix, unscored as unknown", () => {
    const out = occurrenceToFindings(NO_FIX);
    expect(out.map((f) => f.id)).toEqual([
      "projects/my-project/occurrences/0a1b2c3d-2222#glibc@2.36-9",
      "projects/my-project/occurrences/0a1b2c3d-2222#libc-bin@2.36-9",
    ]);
    for (const f of out) {
      expect(f.severity).toBe("unknown");
      expect(f.fixAvailable).toBe(false);
      expect(f.fixedVersion).toBeUndefined();
      expect(f.cvssScore).toBeUndefined();
      expect(f.exploitAvailable).toBeUndefined();
    }
  });

  it("drops occurrences a VEX assessment closed", () => {
    const closed = {
      ...OPENSSL,
      vulnerability: { ...OPENSSL.vulnerability, vexAssessment: { state: "NOT_AFFECTED" } },
    };
    expect(occurrenceToFindings(closed)).toEqual([]);
  });

  it("leaves fixAvailable unset when the scanner does not say", () => {
    const [f] = occurrenceToFindings({
      ...NO_FIX,
      vulnerability: {
        severity: "LOW",
        packageIssue: [{ affectedPackage: "x", affectedVersion: { kind: "NORMAL", name: "1" } }],
      },
    });
    expect(f?.fixAvailable).toBeUndefined();
    expect(f?.severity).toBe("low");
  });
});

function ctxWith(pages: GcpOccurrenceList[], state?: string) {
  let i = 0;
  const listOccurrences = vi.fn(async () => pages[i++] ?? {});
  const getServiceState = vi.fn(async () => state);
  return {
    ctx: { project: "my-project", listOccurrences, getServiceState },
    listOccurrences,
    getServiceState,
  };
}

describe("fetchGcpVulnerabilityFindings", () => {
  it("follows pages and normalises (digest lower-cased)", async () => {
    const { ctx, listOccurrences } = ctxWith([
      { occurrences: [OPENSSL], nextPageToken: "t1" },
      { occurrences: [NO_FIX], nextPageToken: "" },
    ]);
    const out = await fetchGcpVulnerabilityFindings(ctx);
    expect(listOccurrences).toHaveBeenCalledTimes(2);
    expect(listOccurrences).toHaveBeenLastCalledWith("t1");
    expect(out).toHaveLength(3);
    expect(out[0]?.artifact.digest).toBe(
      "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
  });

  it("stops at the page bound", async () => {
    const { ctx, listOccurrences } = ctxWith(
      Array.from({ length: MAX_OCCURRENCE_PAGES + 5 }, (_, n) => ({
        occurrences: [],
        nextPageToken: `t${n}`,
      })),
      "ENABLED",
    );
    await fetchGcpVulnerabilityFindings(ctx);
    expect(listOccurrences).toHaveBeenCalledTimes(MAX_OCCURRENCE_PAGES);
  });

  it("explains an empty list when the Container Scanning API is disabled", async () => {
    const { ctx } = ctxWith([{}], "DISABLED");
    await expect(fetchGcpVulnerabilityFindings(ctx)).rejects.toBeInstanceOf(
      VulnerabilityAccessError,
    );
  });

  it("reports an empty list as clean when scanning is on or its state is unreadable", async () => {
    expect(await fetchGcpVulnerabilityFindings(ctxWith([{}], "ENABLED").ctx)).toEqual([]);
    const unreadable = ctxWith([{}]);
    unreadable.getServiceState.mockRejectedValue(new Error("403"));
    expect(await fetchGcpVulnerabilityFindings(unreadable.ctx)).toEqual([]);
  });

  it("turns a disabled Container Analysis API into an access error with an enable link", async () => {
    const { ctx, listOccurrences } = ctxWith([]);
    listOccurrences.mockRejectedValue(
      Object.assign(
        new Error(
          "The Container Analysis API (containeranalysis.googleapis.com) is not enabled for project my-project.",
        ),
        { status: 403 },
      ),
    );
    const err = await fetchGcpVulnerabilityFindings(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VulnerabilityAccessError);
    expect((err as VulnerabilityAccessError).helpUrl).toContain(
      "apis/library/containeranalysis.googleapis.com",
    );
  });

  it("turns a permission 403 into an access error naming the role", async () => {
    const { ctx, listOccurrences } = ctxWith([]);
    listOccurrences.mockRejectedValue(
      Object.assign(new Error("GCP API 403: PERMISSION_DENIED"), { status: 403 }),
    );
    const err = await fetchGcpVulnerabilityFindings(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VulnerabilityAccessError);
    expect((err as Error).message).toContain("roles/containeranalysis.occurrences.viewer");
  });

  it("propagates a failure on a later page instead of returning a short list", async () => {
    const { ctx, listOccurrences } = ctxWith([]);
    listOccurrences
      .mockResolvedValueOnce({ occurrences: [OPENSSL], nextPageToken: "t1" })
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 503 }));
    await expect(fetchGcpVulnerabilityFindings(ctx)).rejects.toThrow("boom");
  });
});

describe("Cloud Run running images", () => {
  it("declares the image fields the lister writes", () => {
    for (const type of [CloudRunServiceResourceType, CloudRunJobResourceType]) {
      const keys = type.runningImages?.imageKeys ?? [];
      expect(keys).toEqual(["containerImages", "image"]);
      for (const k of keys) expect(type.fields.some((f) => f.key === k)).toBe(true);
    }
  });

  it("collects every container image, sidecars included", () => {
    expect(
      cloudRunContainerImages([
        { image: "us-docker.pkg.dev/p/r/app:v1" },
        { image: "us-docker.pkg.dev/p/r/proxy@sha256:abc" },
        {},
      ]),
    ).toBe("us-docker.pkg.dev/p/r/app:v1\nus-docker.pkg.dev/p/r/proxy@sha256:abc");
  });
});
