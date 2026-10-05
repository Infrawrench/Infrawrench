import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, renderHook } from "@testing-library/react";
import type { CostAccountStatus } from "@infrawrench/client-core";
import { CostBasisField, useCostBasisChoice } from "../../cost/CostGraphConfigModal.js";
import type { CostApi } from "../../cost/types.js";

function status(over: Partial<CostAccountStatus> = {}): CostAccountStatus {
  return {
    accountId: "acc-1",
    pluginId: "aws",
    displayName: "AWS",
    supportsCosts: true,
    periodNative: false,
    dimensions: ["service"],
    chargeTypes: true,
    amortization: true,
    estimated: false,
    costLastPolledAt: null,
    costBackfilledAt: null,
    costPollFailureCount: 0,
    costPollError: null,
    coverage: null,
    ...over,
  };
}

function api(statuses: CostAccountStatus[]): CostApi {
  return { loadCostStatus: vi.fn(async () => statuses) } as unknown as CostApi;
}

describe("CostBasisField", () => {
  it("offers blended only when a provider blends, and explains the selected basis", () => {
    const { rerender } = render(
      <CostBasisField id="b" value="amortized" onChange={() => {}} available hint="unavailable" />,
    );
    expect(screen.queryByRole("option", { name: "Blended" })).toBeNull();
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "title",
      "Commitment fees spread across the days they cover.",
    );

    rerender(
      <CostBasisField
        id="b"
        value="blended"
        onChange={() => {}}
        available
        blendingAvailable
        hint="unavailable"
      />,
    );
    expect(screen.getByRole("option", { name: "Blended" })).toBeInTheDocument();
    expect(screen.getByText(/shared evenly across all the usage it could cover/)).toBeVisible();
  });
});

describe("useCostBasisChoice", () => {
  it("reads blending from the accounts that collect costs", async () => {
    const { result } = renderHook(() =>
      useCostBasisChoice(api([status({ blending: true }), status({ supportsCosts: false })])),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(true);
    expect(result.current.blendingAvailable).toBe(true);
  });

  it("keeps a saved blended basis selectable when no provider blends", async () => {
    const { result } = renderHook(() =>
      useCostBasisChoice(api([status({ amortization: false })]), "blended"),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(true);
    expect(result.current.blendingAvailable).toBe(true);
  });

  it("does not offer blended for an amortizing-only estate", async () => {
    const { result } = renderHook(() => useCostBasisChoice(api([status()])));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.blendingAvailable).toBe(false);
  });
});
