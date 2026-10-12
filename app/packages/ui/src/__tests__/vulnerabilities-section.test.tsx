import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { VulnerabilityFindingRow, VulnerabilityListResponse } from "@infrawrench/client-core";
import { VulnerabilitiesSection } from "../vulnerabilities/VulnerabilitiesSection.js";

const counts = { critical: 1, high: 1, medium: 0, low: 0, unknown: 0 };

function finding(
  advisoryId: string,
  services: VulnerabilityFindingRow["services"],
): VulnerabilityFindingRow {
  return {
    key: `a1\u0000${advisoryId}`,
    accountId: "a1",
    accountName: "Prod",
    pluginId: "aws",
    pluginName: "AWS",
    scanner: "Amazon Inspector",
    findingId: advisoryId,
    advisoryId,
    aliases: [],
    title: null,
    severity: "critical",
    cvssScore: 9.8,
    cvssVector: null,
    packageName: "openssl",
    packageEcosystem: null,
    installedVersion: "3.0.1",
    fixedVersion: "3.0.2",
    fixAvailable: true,
    exploitAvailable: null,
    kev: null,
    artifact: {
      kind: "image",
      name: "registry/app",
      digest: null,
      tags: [],
      resourceExternalId: null,
      url: null,
      key: "image:registry/app",
    },
    firstSeenAt: null,
    lastSeenAt: null,
    url: null,
    collectedAt: "2026-10-01T00:00:00.000Z",
    running: [],
    ...(services ? { services } : {}),
  };
}

function feed(findings: VulnerabilityFindingRow[]): VulnerabilityListResponse {
  return {
    findings,
    totalCount: findings.length,
    counts,
    runningCounts: counts,
    dismissed: [],
    dismissedCount: 0,
    sources: [],
    kevUpdatedAt: null,
    generatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const checkout = { id: "s1", name: "Checkout", slug: "checkout", tier: 1 as const };

describe("VulnerabilitiesSection services", () => {
  it("shows the owning service, opens it, and filters by it", () => {
    const onOpenService = vi.fn();
    render(
      <VulnerabilitiesSection
        data={feed([finding("CVE-1", [checkout]), finding("CVE-2", [])])}
        onOpenService={onOpenService}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Service" })).toBeTruthy();
    const table = screen.getByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "Checkout" }));
    expect(onOpenService).toHaveBeenCalledWith("s1");

    fireEvent.change(screen.getByLabelText("Filter by service"), { target: { value: "s1" } });
    expect(screen.queryByText("CVE-2")).toBeNull();
    expect(screen.getByText("CVE-1")).toBeTruthy();
  });

  it("leaves the column out when no finding is in a service, or the server predates it", () => {
    render(<VulnerabilitiesSection data={feed([finding("CVE-1", undefined)])} />);
    expect(screen.queryByRole("columnheader", { name: "Service" })).toBeNull();
    expect(screen.queryByLabelText("Filter by service")).toBeNull();
  });
});
