import { describe, expect, it, vi } from "vitest";
import { GIT_FORGE_LIMITS, type GitForgePlan, type GitForgeUsage } from "@infrawrench/client-core";

// The modules import the database client at load; the rules under test are pure.
vi.mock("../../db/client.js", () => ({ db: {} }));

const { privateRepositoryRefusal, pushRefusal } = await import("../quota");
const { billableGitBytes, subscriptionHasPrice } = await import("../billing");

const GIB = 1024 ** 3;

const quota = (plan: GitForgePlan, usage: Partial<GitForgeUsage>) => ({
  plan,
  limits: GIT_FORGE_LIMITS[plan],
  usage: {
    repositories: 0,
    publicRepositories: 0,
    privateRepositories: 0,
    storageBytes: 0,
    privateStorageBytes: 0,
    ...usage,
  },
});

describe("privateRepositoryRefusal", () => {
  it("lets a free organisation hold three private repositories and refuses the fourth", () => {
    expect(privateRepositoryRefusal(quota("free", { privateRepositories: 2 }))).toBeNull();
    const refusal = privateRepositoryRefusal(quota("free", { privateRepositories: 3 }));
    expect(refusal).toContain("3 private repositories");
    expect(refusal).toContain("Settings > Billing");
  });

  it("never refuses a paid organisation", () => {
    expect(privateRepositoryRefusal(quota("paid", { privateRepositories: 5000 }))).toBeNull();
  });

  it("gives a person's own namespace a fixed allowance, with no upgrade to offer", () => {
    expect(privateRepositoryRefusal(quota("personal", { privateRepositories: 4 }))).toBeNull();
    const refusal = privateRepositoryRefusal(quota("personal", { privateRepositories: 5 }));
    expect(refusal).toContain("5 private repositories");
    expect(refusal).not.toContain("Billing");
  });

  it("does not count public repositories", () => {
    expect(
      privateRepositoryRefusal(quota("free", { repositories: 400, publicRepositories: 400 })),
    ).toBeNull();
  });
});

describe("pushRefusal", () => {
  it("refuses once private storage reaches the plan's limit, and says how much is used", () => {
    expect(pushRefusal(quota("free", { privateStorageBytes: GIB - 1 }))).toBeNull();
    const refusal = pushRefusal(quota("free", { privateStorageBytes: 1.5 * GIB }));
    expect(refusal).toMatch(
      /^storage quota exceeded: private repositories here use 1\.5 GiB of 1 GiB;/,
    );
    expect(refusal).toContain("upgrade");
  });

  it("counts private storage only: public repositories are free", () => {
    expect(
      pushRefusal(quota("free", { storageBytes: 900 * GIB, privateStorageBytes: 0 })),
    ).toBeNull();
  });

  it("gives a paid organisation its hard limit, well above what is included", () => {
    expect(pushRefusal(quota("paid", { privateStorageBytes: 60 * GIB }))).toBeNull();
    expect(pushRefusal(quota("paid", { privateStorageBytes: 100 * GIB }))).toContain(
      "100 GiB of 100 GiB",
    );
  });
});

describe("billableGitBytes", () => {
  it("meters a paid organisation's private storage above what the plan includes", () => {
    expect(billableGitBytes(4 * GIB, true)).toBe(0);
    expect(billableGitBytes(10 * GIB, true)).toBe(0);
    expect(billableGitBytes(12.5 * GIB, true)).toBe(2.5 * GIB);
  });

  it("never meters a free organisation: its allowance is a limit, not a rate", () => {
    expect(billableGitBytes(3 * GIB, false)).toBe(0);
  });
});

describe("subscriptionHasPrice", () => {
  const listing = {
    object: "list",
    data: [
      { id: "si_seat", price: { id: "price_seat" } },
      { id: "si_storage", price: { id: "price_storage" } },
    ],
  };

  it("finds the storage price among a subscription's items", () => {
    expect(subscriptionHasPrice(listing, "price_storage")).toBe(true);
    expect(subscriptionHasPrice(listing, "price_other")).toBe(false);
    expect(subscriptionHasPrice({ data: [] }, "price_storage")).toBe(false);
  });

  it("refuses an answer that is not a list, rather than adding a second item", () => {
    expect(() => subscriptionHasPrice({ error: { message: "no" } }, "price_storage")).toThrow();
    expect(() => subscriptionHasPrice(null, "price_storage")).toThrow();
  });
});
