import { VulnerabilityAccessError } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { plugin } from "../plugin.js";
import { fetchDependabotFindings, mapDependabotAlert } from "../vulnerabilities.js";
import type { GhDependabotAlert } from "../vulnerabilities.js";
import { ctxWith } from "./helpers.js";

/**
 * Shaped after the response schema of "List Dependabot alerts for an
 * organization" (https://docs.github.com/en/rest/dependabot/alerts#list-dependabot-alerts-for-an-organization),
 * trimmed to the fields the mapper reads plus a few it must ignore.
 */
const ALERT: GhDependabotAlert & Record<string, unknown> = {
  number: 2,
  state: "open",
  dependency: {
    package: { ecosystem: "pip", name: "django" },
    manifest_path: "path/to/requirements.txt",
    scope: "runtime",
    relationship: "direct",
  },
  security_advisory: {
    ghsa_id: "GHSA-rf4j-j272-fj86",
    cve_id: "CVE-2018-6188",
    summary: "Django allows remote attackers to obtain potentially sensitive information",
    severity: "high",
    cvss: {
      vector_string: "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
      score: 7.5,
    },
    cvss_severities: {
      cvss_v3: { vector_string: "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", score: 7.5 },
      cvss_v4: {
        vector_string: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N",
        score: 8.7,
      },
    },
    identifiers: [
      { value: "GHSA-rf4j-j272-fj86", type: "GHSA" },
      { value: "CVE-2018-6188", type: "CVE" },
    ],
    withdrawn_at: null,
  },
  security_vulnerability: {
    package: { ecosystem: "pip", name: "django" },
    severity: "high",
    vulnerable_version_range: ">= 2.0.0, < 2.0.2",
    first_patched_version: { identifier: "2.0.2" },
  },
  url: "https://api.github.com/repos/octo-org/octo-repo/dependabot/alerts/2",
  html_url: "https://github.com/octo-org/octo-repo/security/dependabot/2",
  created_at: "2022-06-15T07:43:03Z",
  updated_at: "2022-08-23T14:29:47Z",
  dismissed_at: null,
  fixed_at: null,
  repository: {
    full_name: "octo-org/octo-repo",
    html_url: "https://github.com/octo-org/octo-repo",
  },
};

const NO_PATCH: GhDependabotAlert = {
  number: 1,
  state: "open",
  dependency: { package: { ecosystem: "npm", name: "left-pad" } },
  security_advisory: {
    ghsa_id: "GHSA-aaaa-bbbb-cccc",
    cve_id: null,
    summary: "Something unpatched",
    severity: "medium",
    cvss: { vector_string: null, score: 0 },
    cvss_severities: null,
    identifiers: [{ value: "GHSA-aaaa-bbbb-cccc", type: "GHSA" }],
  },
  security_vulnerability: {
    package: { ecosystem: "npm", name: "left-pad" },
    severity: "medium",
    vulnerable_version_range: "< 9.9.9",
    first_patched_version: null,
  },
  html_url: "https://github.com/octo-org/web/security/dependabot/1",
  created_at: "2026-09-01T00:00:00Z",
  repository: { full_name: "octo-org/web" },
};

interface Call {
  url: URL;
}

function linkedHttp(pages: Record<string, { status?: number; body: unknown; link?: string }>) {
  const calls: Call[] = [];
  const http = {
    async request(req: { url: string; method: string; headers: Record<string, string> }) {
      const url = new URL(req.url);
      calls.push({ url });
      const reply = pages[url.searchParams.get("after") ?? ""] ?? { status: 500, body: {} };
      return {
        status: reply.status ?? 200,
        headers: reply.link ? { Link: reply.link } : {},
        body: JSON.stringify(reply.body),
      };
    },
  };
  return { http, calls };
}

describe("mapDependabotAlert", () => {
  it("maps the documented alert shape", () => {
    expect(mapDependabotAlert(ALERT)).toEqual({
      id: "octo-org/octo-repo#2",
      advisoryId: "CVE-2018-6188",
      aliases: ["GHSA-rf4j-j272-fj86"],
      title: "Django allows remote attackers to obtain potentially sensitive information",
      severity: "high",
      cvssScore: 7.5,
      cvssVector: "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
      packageName: "django",
      packageEcosystem: "pip",
      fixedVersion: "2.0.2",
      fixAvailable: true,
      artifact: {
        kind: "repository",
        name: "octo-org/octo-repo",
        url: "https://github.com/octo-org/octo-repo",
      },
      firstSeenAt: "2022-06-15T07:43:03Z",
      url: "https://github.com/octo-org/octo-repo/security/dependabot/2",
    });
  });

  it("falls back to the GHSA id, skips an unscored CVSS and says no patch exists", () => {
    const f = mapDependabotAlert(NO_PATCH)!;
    expect(f.advisoryId).toBe("GHSA-aaaa-bbbb-cccc");
    expect(f.cvssScore).toBeUndefined();
    expect(f.cvssVector).toBeUndefined();
    expect(f.fixAvailable).toBe(false);
    expect(f.fixedVersion).toBeUndefined();
    expect(f.severity).toBe("medium");
  });

  it("leaves fixAvailable unknown when the response does not carry the field", () => {
    const { first_patched_version: _drop, ...vuln } = NO_PATCH.security_vulnerability!;
    const f = mapDependabotAlert({ ...NO_PATCH, security_vulnerability: vuln })!;
    expect("fixAvailable" in f).toBe(false);
  });

  it("drops withdrawn advisories", () => {
    expect(
      mapDependabotAlert({
        ...ALERT,
        security_advisory: { ...ALERT.security_advisory, withdrawn_at: "2026-01-01T00:00:00Z" },
      }),
    ).toBeUndefined();
  });
});

describe("fetchDependabotFindings", () => {
  it("asks for open alerts and follows the Link cursor", async () => {
    const { http, calls } = linkedHttp({
      "": {
        body: [ALERT],
        link: '<https://api.github.com/organizations/1/dependabot/alerts?state=open&per_page=100&after=Y3Vyc29yOjI>; rel="next"',
      },
      Y3Vyc29yOjI: { body: [NO_PATCH] },
    });
    const findings = await fetchDependabotFindings(ctxWith(http));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe("/orgs/octo-org/dependabot/alerts");
    expect(calls[0]!.url.searchParams.get("state")).toBe("open");
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("100");
    // The cursor is taken from the Link URL; the path stays our own.
    expect(calls[1]!.url.pathname).toBe("/orgs/octo-org/dependabot/alerts");
    expect(calls[1]!.url.searchParams.get("after")).toBe("Y3Vyc29yOjI");
    expect(findings.map((f) => f.id)).toEqual(["octo-org/octo-repo#2", "octo-org/web#1"]);
    // Normalised: advisory ids are upper-cased.
    expect(findings[0]!.aliases).toEqual(["GHSA-RF4J-J272-FJ86"]);
  });

  it("uses the enterprise route for an enterprise account", async () => {
    const { http, calls } = linkedHttp({ "": { body: [] } });
    await fetchDependabotFindings(ctxWith(http, "enterprise:octo-ent"));
    expect(calls[0]!.url.pathname).toBe("/enterprises/octo-ent/dependabot/alerts");
  });

  it("explains a missing permission as an access error", async () => {
    const { http } = linkedHttp({
      "": { status: 403, body: { message: "Resource not accessible by personal access token" } },
    });
    const err = await fetchDependabotFindings(ctxWith(http)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VulnerabilityAccessError);
    expect((err as Error).message).toMatch(/Dependabot alerts" \(read\)/);
  });

  it("explains disabled alerts as an access error", async () => {
    const { http } = linkedHttp({
      "": {
        status: 403,
        body: { message: "Dependabot alerts are disabled for this organization." },
      },
    });
    const err = await fetchDependabotFindings(ctxWith(http)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VulnerabilityAccessError);
    expect((err as VulnerabilityAccessError).helpUrl).toMatch(/configuring-dependabot-alerts/);
  });

  it("throws rather than returning a short list when a later page fails", async () => {
    const { http } = linkedHttp({
      "": {
        body: [ALERT],
        link: '<https://api.github.com/orgs/octo-org/dependabot/alerts?after=next>; rel="next"',
      },
      next: { status: 502, body: { message: "Bad gateway" } },
    });
    await expect(fetchDependabotFindings(ctxWith(http))).rejects.toThrow(/502/);
  });
});

describe("manifest", () => {
  it("declares the Dependabot capability and the client implements it", () => {
    expect(plugin.manifest.vulnerabilities?.label).toBe("Dependabot");
    const client = plugin.createClient({ token: "t", owner: "org:o" });
    expect(typeof client.listVulnerabilityFindings).toBe("function");
  });
});
