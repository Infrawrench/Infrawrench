import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { GIT_FORGE_LIMITS } from "@infrawrench/client-core";

vi.mock("gt-react", () => ({
  useGT: () => (s: string, vars?: Record<string, string>) =>
    s.replace(/\{(\w+)\}/g, (_, k: string) => vars?.[k] ?? ""),
}));

const { startProCheckout } = await import("../checkout.js");
const { usePlanFeatureLines } = await import("../plan-features.js");

const GIB = 1024 ** 3;

describe("the plan comparison's CI and Git lines", () => {
  it("puts Infrawrench CI on Pro only, and says so where Free is described", () => {
    const { result } = renderHook(() => usePlanFeatureLines());
    expect(result.current.pro).toContain("Infrawrench CI, billed by usage");
    expect(result.current.freeWithout).toEqual(["Infrawrench CI is part of Pro"]);
    expect(result.current.free.join("\n")).not.toMatch(/Infrawrench CI/);
  });

  it("quotes the limits the forge enforces, not numbers of its own", () => {
    const { free, paid } = GIT_FORGE_LIMITS;
    const { result } = renderHook(() => usePlanFeatureLines());
    expect(result.current.free[0]).toBe(
      `git.infrawrench.com: public repositories, plus ${free.privateRepositories} private (up to ${free.privateStorageBytes / GIB} GiB)`,
    );
    // No limit on private repositories on a paid plan, and its included storage.
    expect(paid.privateRepositories).toBeNull();
    expect(result.current.pro[1]).toBe(
      `git.infrawrench.com: your organization's name, unlimited private repositories, ${paid.includedStorageBytes / GIB} GiB included`,
    );
  });

  it("says review agents draw on AI usage on both plans", () => {
    const { result } = renderHook(() => usePlanFeatureLines());
    expect(result.current.free).toContain("Review agents, from the same AI allowance");
    expect(result.current.pro).toContain("Review agents, billed with your AI usage");
  });
});

describe("startProCheckout", () => {
  it("asks the billing domain for a checkout and sends the member there in the same tab", async () => {
    const post = vi.fn(async () => ({ url: "https://checkout.stripe.example/c/1" }));
    const openExternal = vi.fn();
    await startProCheckout({
      orgId: "org-1",
      post: post as never,
      openExternal,
      readCheckoutMeasurement: () => ({ consentState: "granted", anonymousId: "anon-1" }),
    });
    expect(post).toHaveBeenCalledWith("/api/org/org-1/billing/checkout", {
      measurement: { consentState: "granted", anonymousId: "anon-1" },
    });
    expect(openExternal).toHaveBeenCalledWith("https://checkout.stripe.example/c/1", {
      sameTab: true,
    });
  });

  it("sends no body without a measurement, and opens nothing when the server refuses", async () => {
    const post = vi.fn(async () => ({ url: "https://checkout.stripe.example/c/2" }));
    const openExternal = vi.fn();
    await startProCheckout({ orgId: "org-1", post: post as never, openExternal });
    expect(post).toHaveBeenCalledWith("/api/org/org-1/billing/checkout", undefined);

    openExternal.mockClear();
    await expect(
      startProCheckout({
        orgId: "org-1",
        post: (async () => {
          throw new Error("Forbidden");
        }) as never,
        openExternal,
      }),
    ).rejects.toThrow("Forbidden");
    expect(openExternal).not.toHaveBeenCalled();
  });
});
