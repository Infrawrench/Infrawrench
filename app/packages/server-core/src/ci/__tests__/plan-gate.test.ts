/**
 * Infrawrench CI on the free plan: everything that starts CI or sets it up
 * is refused with the plan's sentence before it reads or writes anything,
 * and what puts things away is not asked at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const plan = vi.hoisted(() => ({
  access: { paid: false, reason: "none" } as { paid: boolean; reason: string; status?: string },
}));
vi.mock("../../entitlements.js", async (orig) => ({
  ...(await orig<typeof import("../../entitlements.js")>()),
  planAccess: async () => plan.access,
}));

// The database and the runner pool answer nothing here: a call that gets as
// far as either has passed the gate, and says so.
const reached = vi.hoisted(() => ({ db: 0, proxy: 0 }));
vi.mock("../../db/client.js", () => {
  const touch = (): never => {
    reached.db += 1;
    throw new Error("reached the database");
  };
  return { db: { select: touch, insert: touch, update: touch, delete: touch } };
});
vi.mock("../proxy.js", async (orig) => ({
  ...(await orig<typeof import("../proxy.js")>()),
  proxyJson: async () => {
    reached.proxy += 1;
    throw new Error("reached the runner pool");
  },
}));

const { PlanRequiredError } = await import("../../entitlements.js");
const { setCiAccount } = await import("../accounts");
const { requireCiPlan } = await import("../plan");
const { approveRun, retryRun, startManualRun } = await import("../runs");
const { deleteCiValue, setCiValue } = await import("../values");

const ORG = "org-free";
const RUN = "11111111-1111-4111-8111-111111111111";

/** Everything a member can do that starts CI or sets it up. */
const gated: Record<string, () => Promise<unknown>> = {
  "turning CI on for a GitHub account": () => setCiAccount(ORG, 7, true, "user-1"),
  "starting a pipeline by hand": () =>
    startManualRun(ORG, "user-1", "octo", {
      installationId: 7,
      repoFullName: "acme/web",
      pipelineFile: ".infrawrench/ci/deploy.yml",
    }),
  "retrying a run": () => retryRun(ORG, RUN, "user-1", { noTaskCache: false }),
  "approving a fork's commit": () => approveRun(ORG, RUN, "user-1"),
  "setting a secret": () => setCiValue(ORG, 7, null, "secrets", "NPM_TOKEN", "value"),
  "setting a variable": () => setCiValue(ORG, 7, "web", "variables", "REGION", "eu"),
};

beforeEach(() => {
  plan.access = { paid: false, reason: "none" };
  reached.db = 0;
  reached.proxy = 0;
});

describe("the CI plan gate", () => {
  for (const [what, call] of Object.entries(gated)) {
    it(`refuses ${what} on the free plan, before anything is read or written`, async () => {
      const refusal = await call().then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(PlanRequiredError);
      expect(refusal).toMatchObject({
        status: 402,
        message: "Infrawrench CI is part of Pro. Upgrade under Settings → Billing.",
      });
      expect(reached).toEqual({ db: 0, proxy: 0 });
    });

    it(`lets ${what} through on a paid plan`, async () => {
      plan.access = { paid: true, reason: "subscription", status: "active" };
      // Past the gate it reaches the (absent) database: not a plan refusal.
      await expect(call()).rejects.toThrow("reached the database");
    });
  }

  it("counts a trial and a complimentary organization as paid", async () => {
    for (const reason of ["trial", "complimentary", "capacity_slot"]) {
      plan.access = { paid: true, reason };
      await expect(requireCiPlan(ORG)).resolves.toBeUndefined();
    }
  });

  it("tells a lapsed subscription to reactivate rather than upgrade", async () => {
    plan.access = { paid: false, reason: "inactive", status: "canceled" };
    await expect(requireCiPlan(ORG)).rejects.toThrow(
      "Infrawrench CI needs an active plan. This organization's subscription is canceled. Reactivate it under Settings → Billing.",
    );
  });

  it("never asks before turning an account off or deleting a value", async () => {
    // Both reach the database without a word about the plan: an
    // organization whose plan ended can still put things away.
    await expect(setCiAccount(ORG, 7, false, "user-1")).rejects.toThrow("reached the database");
    await expect(deleteCiValue(ORG, 7, null, "secrets", "NPM_TOKEN")).rejects.toThrow(
      "reached the database",
    );
  });
});
