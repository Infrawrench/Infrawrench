import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InstancePricingQuery, InstancePricingResult } from "@infrawrench/client-core";
import { InstancePricingPanel } from "../components/detail/InstancePricingPanel.js";

function result(columns: string[], rows: (string | number | null)[][]): InstancePricingResult {
  return {
    columns: columns.map((name) => ({ name, type: "String" })),
    rows,
    truncated: false,
    elapsedMs: 1,
  };
}

/** Answers by which table and shape a statement asks for. Each test uses its own type name. */
function warehouse(): InstancePricingQuery {
  return vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT DISTINCT region")) {
      return result(["region"], [["us-east-1"], ["eu-west-1"]]);
    }
    if (sql.includes("FROM regions")) {
      return result(["region", "location"], [["us-east-1", "US East (N. Virginia)"]]);
    }
    if (sql.includes("FROM instance_types")) {
      return result(
        ["family", "vcpu", "memory_gib", "attributes"],
        [["m7g", 2, 8, '{"ecu":"NA"}']],
      );
    }
    if (sql.includes("hourly_usd, upfront_usd")) {
      return result(
        [
          "pricing",
          "lease",
          "offering_class",
          "purchase_option",
          "operating_system",
          "effective_hourly_usd",
        ],
        [
          ["on_demand", "", "", "", "Linux", 0.0816],
          ["on_demand", "", "", "", "Windows", 0.2],
          ["reserved", "1yr", "standard", "No Upfront", "Linux", 0.05],
        ],
      );
    }
    return result([], []);
  });
}

describe("InstancePricingPanel", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  const capability = (type: string) => ({
    platform: "ec2",
    instanceTypes: [type],
    region: "us-east-1",
    selection: { operating_system: "Linux" },
  });

  it("runs nothing until it is opened", () => {
    const query = warehouse();
    render(<InstancePricingPanel capability={capability("closed.large")} query={query} />);
    expect(screen.getByRole("button", { expanded: false })).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });

  it("shows prices, specs and pickers once opened, and remembers that", async () => {
    const query = warehouse();
    render(<InstancePricingPanel capability={capability("open.large")} query={query} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    await screen.findAllByText("$0.0816");
    expect(screen.getAllByText("$0.05").length).toBeGreaterThan(0);
    expect(screen.getByText("vCPUs")).toBeTruthy();
    expect(screen.getByLabelText("Operating system")).toBeTruthy();
    expect(window.localStorage.getItem("infrawrench-instance-pricing-open")).toBe("1");
  });

  it("follows a picked variant", async () => {
    const query = warehouse();
    render(<InstancePricingPanel capability={capability("pick.large")} query={query} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await screen.findAllByText("$0.0816");

    fireEvent.change(screen.getByLabelText("Operating system"), {
      target: { value: "Windows" },
    });
    await screen.findAllByText("$0.20");
    await waitFor(() =>
      expect(
        vi
          .mocked(query)
          .mock.calls.some(([sql]) => sql.includes("operating_system IN ('Windows', '')")),
      ).toBe(true),
    );
  });

  it("offers a retry when the warehouse is down", async () => {
    const query = vi
      .fn<InstancePricingQuery>()
      .mockRejectedValue(new Error("The instance pricing warehouse is unavailable"));
    render(<InstancePricingPanel capability={capability("down.large")} query={query} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(query.mock.calls.length).toBeGreaterThan(1);
  });

  it("says so when the provider lists no price for the type", async () => {
    const query = vi.fn<InstancePricingQuery>(async () => result(["region"], []));
    render(<InstancePricingPanel capability={capability("none.large")} query={query} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await screen.findByText("none.large has no published on-demand prices.");
  });
});
