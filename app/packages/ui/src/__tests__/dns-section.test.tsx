import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DnsSection } from "../dns/DnsSection.js";
import type { DnsInventoryResponse, DnsRecordEntry, DnsZoneEntry } from "@infrawrench/client-core";

function zone(overrides: Partial<DnsZoneEntry> = {}): DnsZoneEntry {
  return {
    resourceId: "z1",
    pluginId: "cloudflare",
    pluginName: "Cloudflare",
    resourceTypeId: "zone",
    resourceTypeName: "Zone",
    accountId: "a1",
    accountName: "Prod",
    domain: "example.com",
    status: "active",
    isPrivate: false,
    recordCount: 2,
    providerRecordCount: null,
    danglingCount: 1,
    ...overrides,
  };
}

function record(overrides: Partial<DnsRecordEntry> = {}): DnsRecordEntry {
  return {
    resourceId: "r1",
    pluginId: "cloudflare",
    pluginName: "Cloudflare",
    resourceTypeId: "dns-record",
    resourceTypeName: "DNS Record",
    accountId: "a1",
    accountName: "Prod",
    zoneResourceId: "z1",
    zoneDomain: "example.com",
    name: "www.example.com",
    type: "CNAME",
    ttl: 300,
    priority: null,
    proxied: false,
    targets: [
      {
        value: "gone.vercel.app",
        classification: "dangling",
        resource: null,
        service: {
          pluginId: "vercel",
          pluginName: "Vercel",
          resourceTypeId: "vercel-project",
          ruleId: "vercel-alias",
          label: "Vercel deployment alias",
          severity: "high",
          reason: "Anyone can claim the alias.",
          claimLabel: "gone",
        },
      },
    ],
    status: "dangling",
    ...overrides,
  };
}

function inventory(overrides: Partial<DnsInventoryResponse> = {}): DnsInventoryResponse {
  return {
    zones: [zone()],
    records: [record()],
    counts: { zones: 1, records: 1, owned: 0, dangling: 1, external: 0, notAnalysed: 0 },
    skippedNamespaces: [],
    generatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("DnsSection", () => {
  it("names the dangling target and what nothing claims", () => {
    render(<DnsSection data={inventory()} />);
    expect(screen.getByText("www.example.com")).toBeInTheDocument();
    expect(screen.getByText("gone.vercel.app")).toBeInTheDocument();
    // The row names the specific label; the footnote below says the same thing
    // in general, hence the more specific matcher.
    expect(screen.getByText(/nothing synced claims “gone”/)).toBeInTheDocument();
    expect(screen.getByText("1 dangling")).toBeInTheDocument();
  });

  it("filters records by status", () => {
    render(
      <DnsSection
        data={inventory({
          records: [
            record(),
            record({
              resourceId: "r2",
              name: "api.example.com",
              status: "external",
              targets: [
                {
                  value: "app.somesaas.com",
                  classification: "external",
                  resource: null,
                  service: null,
                },
              ],
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dangling" }));
    expect(screen.queryByText("api.example.com")).not.toBeInTheDocument();
    expect(screen.getByText("www.example.com")).toBeInTheDocument();
  });

  it("says which namespaces went unchecked rather than implying a clean bill", () => {
    render(
      <DnsSection
        data={inventory({
          skippedNamespaces: [
            {
              pluginId: "aws",
              pluginName: "AWS",
              label: "S3 bucket endpoint",
              reason: "No AWS account is connected.",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    expect(screen.getByText("S3 bucket endpoint")).toBeInTheDocument();
  });

  it("keeps the drawn inventory on a failed refresh", () => {
    render(<DnsSection data={inventory()} error="network down" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/showing the last loaded inventory/);
    expect(screen.getByText("www.example.com")).toBeInTheDocument();
  });

  it("offers a retry when the first load failed outright", () => {
    const onRetry = vi.fn();
    render(<DnsSection data={null} error="network down" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("opens the record's resource when a row is activated", () => {
    const onOpenRecord = vi.fn();
    render(<DnsSection data={inventory()} onOpenRecord={onOpenRecord} />);
    fireEvent.click(screen.getByText("www.example.com"));
    expect(onOpenRecord).toHaveBeenCalledWith(expect.objectContaining({ resourceId: "r1" }));
  });

  // A <tr> can be given tabIndex but has no role a screen reader announces as
  // activatable, so navigation lives on a real button in the name cell — which
  // is what makes both listings keyboard-operable at all.
  it("carries record and zone navigation on real buttons, not the row", () => {
    render(<DnsSection data={inventory()} onOpenRecord={() => {}} onOpenZone={() => {}} />);
    expect(screen.getByRole("button", { name: "www.example.com" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "example.com" })).toBeInTheDocument();
  });

  it("opens the zone from its name button", () => {
    const onOpenZone = vi.fn();
    render(<DnsSection data={inventory()} onOpenZone={onOpenZone} />);
    fireEvent.click(screen.getByRole("button", { name: "example.com" }));
    expect(onOpenZone).toHaveBeenCalledWith(expect.objectContaining({ resourceId: "z1" }));
  });

  it("leaves names as plain text when the host offers no navigation", () => {
    render(<DnsSection data={inventory()} />);
    expect(screen.queryByRole("button", { name: "www.example.com" })).toBeNull();
    expect(screen.getByText("www.example.com")).toBeInTheDocument();
  });
});
