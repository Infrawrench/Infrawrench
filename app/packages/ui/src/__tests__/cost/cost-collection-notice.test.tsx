import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CostAccountStatus } from "@infrawrench/client-core";
import { CostCollectionNotice } from "../../cost/CostCollectionNotice.js";

function status(over: Partial<CostAccountStatus> = {}): CostAccountStatus {
  return {
    accountId: "acc-1",
    pluginId: "gcp",
    displayName: "Infrawrench GCP",
    supportsCosts: true,
    periodNative: false,
    dimensions: ["service"],
    costLastPolledAt: "2026-07-25T21:44:13.000Z",
    costBackfilledAt: null,
    costPollFailureCount: 1,
    costPollError: null,
    coverage: { firstDay: "2026-06-01", lastDay: "2026-07-25" },
    ...over,
  };
}

describe("CostCollectionNotice", () => {
  it("renders nothing when every account is collecting cleanly", () => {
    const { container } = render(<CostCollectionNotice statuses={[status()]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("ignores a stored error on an account whose plugin has no cost support", () => {
    const { container } = render(
      <CostCollectionNotice
        statuses={[
          status({ supportsCosts: false, costPollError: { message: "stale", helpLink: null } }),
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the account and shows the provider's message", () => {
    render(
      <CostCollectionNotice
        statuses={[
          status({ costPollError: { message: "Billing export isn't enabled.", helpLink: null } }),
        ]}
      />,
    );
    expect(screen.getByText(/Cost collection is failing for Infrawrench GCP/)).toBeInTheDocument();
    expect(screen.getByText(/Billing export isn't enabled\./)).toBeInTheDocument();
  });

  it("renders the help link as a new-tab anchor", () => {
    render(
      <CostCollectionNotice
        statuses={[
          status({
            costPollError: {
              message: "Billing export isn't enabled.",
              helpLink: {
                label: "Enable billing export",
                url: "https://console.cloud.google.com/billing/export?project=p",
              },
            },
          }),
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: /Enable billing export/ });
    expect(link).toHaveAttribute(
      "href",
      "https://console.cloud.google.com/billing/export?project=p",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("routes the link through the host opener when one is given", () => {
    const onOpenExternal = vi.fn();
    render(
      <CostCollectionNotice
        onOpenExternal={onOpenExternal}
        statuses={[
          status({
            costPollError: {
              message: "Billing export isn't enabled.",
              helpLink: { label: "Enable billing export", url: "https://example.com/setup" },
            },
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: /Enable billing export/ }));
    expect(onOpenExternal).toHaveBeenCalledWith("https://example.com/setup");
  });

  it("summarizes and labels each account when several are failing", () => {
    render(
      <CostCollectionNotice
        statuses={[
          status({ costPollError: { message: "Billing export missing.", helpLink: null } }),
          status({
            accountId: "acc-2",
            pluginId: "aws",
            displayName: "Prod AWS",
            costPollError: { message: "Cost Explorer access denied.", helpLink: null },
          }),
        ]}
      />,
    );
    expect(screen.getByText("Cost collection is failing for 2 accounts")).toBeInTheDocument();
    expect(screen.getByText(/Prod AWS/)).toBeInTheDocument();
    expect(screen.getByText(/Cost Explorer access denied\./)).toBeInTheDocument();
  });

  it("explains an account that collected cleanly but has no data", () => {
    render(<CostCollectionNotice statuses={[status({ coverage: null })]} />);
    expect(screen.getByText("No spend data yet for Infrawrench GCP")).toBeInTheDocument();
    expect(screen.getByText(/Collection ran without error/i)).toBeInTheDocument();
  });

  it("stays quiet for an account that has never been polled", () => {
    const { container } = render(
      <CostCollectionNotice statuses={[status({ coverage: null, costLastPolledAt: null })]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names each account when several are awaiting data", () => {
    render(
      <CostCollectionNotice
        statuses={[
          status({ coverage: null }),
          status({ accountId: "acc-2", displayName: "Prod AWS", coverage: null }),
        ]}
      />,
    );
    expect(screen.getByText("No spend data yet for 2 accounts")).toBeInTheDocument();
    expect(screen.getByText("Prod AWS")).toBeInTheDocument();
  });

  it("reports a failing account and an empty one side by side", () => {
    render(
      <CostCollectionNotice
        statuses={[
          status({ coverage: null, costPollError: { message: "Access denied.", helpLink: null } }),
          status({ accountId: "acc-2", displayName: "Prod AWS", coverage: null }),
        ]}
      />,
    );
    expect(screen.getByText(/Cost collection is failing for Infrawrench GCP/)).toBeInTheDocument();
    expect(screen.getByText("No spend data yet for Prod AWS")).toBeInTheDocument();
  });
});
