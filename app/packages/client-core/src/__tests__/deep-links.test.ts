import { describe, expect, it } from "vitest";
import {
  desktopDeepLink,
  parseDesktopDeepLink,
  parseOrgIdInput,
  webIncidentUrl,
  webResourceUrl,
  webServiceUrl,
} from "../deep-links";

const resource = {
  accountId: "acc-1",
  pluginId: "aws",
  resourceTypeId: "ec2-instance",
  resourceId: "us-east-1/i-0abc",
};

describe("web URLs", () => {
  it("encodes a slash-bearing resource id as one path segment", () => {
    expect(webResourceUrl("https://app.example.com/", "org-1", resource)).toBe(
      "https://app.example.com/org/org-1/resources/aws/ec2-instance/us-east-1%2Fi-0abc?accountId=acc-1",
    );
  });

  it("addresses incidents and services by path", () => {
    expect(webIncidentUrl("https://x.test", "o", "i 1")).toBe(
      "https://x.test/org/o/incidents/i%201",
    );
    expect(webIncidentUrl("https://x.test", "o")).toBe("https://x.test/org/o/incidents");
    expect(webServiceUrl("https://x.test", "o", "s1")).toBe("https://x.test/org/o/services/s1");
  });
});

describe("desktop deep links", () => {
  it("round-trips every kind", () => {
    const links = [
      { kind: "resource" as const, orgId: "org-1", ...resource },
      { kind: "incident" as const, orgId: "org-1", incidentId: "inc-9" },
      { kind: "service" as const, orgId: "org-1", serviceId: "svc-2" },
    ];
    for (const link of links) {
      const url = desktopDeepLink(link);
      expect(url.startsWith("infrawrench://open/")).toBe(true);
      expect(parseDesktopDeepLink(url)).toEqual(link);
    }
  });

  it("ignores the OAuth callback, other schemes and half-formed links", () => {
    expect(parseDesktopDeepLink("infrawrench://callback?code=abc&state=x")).toBeNull();
    expect(parseDesktopDeepLink("https://open/resource?org=o&id=1")).toBeNull();
    expect(parseDesktopDeepLink("infrawrench://open/resource?org=o&id=1")).toBeNull();
    expect(parseDesktopDeepLink("infrawrench://open/unknown?org=o&id=1")).toBeNull();
    expect(parseDesktopDeepLink("not a url")).toBeNull();
  });
});

describe("parseOrgIdInput", () => {
  it("takes an id or any web URL inside the org", () => {
    expect(parseOrgIdInput("8f2c1a9e-1111-2222-3333-444455556666")).toBe(
      "8f2c1a9e-1111-2222-3333-444455556666",
    );
    expect(parseOrgIdInput("https://app.infrawrench.com/org/abc123/settings/api-keys")).toBe(
      "abc123",
    );
    expect(parseOrgIdInput("  ")).toBeNull();
    expect(parseOrgIdInput("not an id!")).toBeNull();
  });
});
