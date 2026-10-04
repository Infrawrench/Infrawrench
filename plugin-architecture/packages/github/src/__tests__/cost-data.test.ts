import { CostSetupError } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { fetchGitHubCostData, toCostRows } from "../cost-data.js";
import { ctxWith, makeHttp } from "./helpers.js";

const range = { fromDate: "2026-09-01", toDate: "2026-09-30" };

describe("toCostRows", () => {
  it("writes gross as usage and the discount as a credit, so the sum is the net bill", () => {
    const rows = toCostRows(
      [
        {
          date: "2026-09-03T00:00:00Z",
          product: "Actions",
          sku: "Actions Linux",
          quantity: 1000,
          unitType: "minutes",
          pricePerUnit: 0.006,
          grossAmount: 6,
          discountAmount: 4,
          netAmount: 2,
          organizationName: "octo-org",
          repositoryName: "octo-org/app",
        },
      ],
      range,
      false,
    );
    expect(rows).toEqual([
      {
        date: "2026-09-03",
        service: "Actions",
        resourceId: "octo-org/app",
        tags: { sku: "actions_linux" },
        currency: "USD",
        amount: 6,
        chargeType: "usage",
        usageAmount: 1000,
        usageUnit: "minutes",
      },
      {
        date: "2026-09-03",
        service: "Actions",
        resourceId: "octo-org/app",
        tags: { sku: "actions_linux" },
        currency: "USD",
        amount: -4,
        chargeType: "credit",
      },
    ]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(2);
  });

  it("aggregates duplicate lines, files LFS under its own product and drops out-of-range days", () => {
    const rows = toCostRows(
      [
        {
          date: "2026-09-04",
          product: "Packages",
          sku: "git_lfs_storage",
          quantity: 1,
          grossAmount: 1,
          discountAmount: 0,
          netAmount: 1,
        },
        {
          date: "2026-09-04",
          product: "Packages",
          sku: "git_lfs_storage",
          quantity: 2,
          grossAmount: 2,
          discountAmount: 0,
          netAmount: 2,
        },
        {
          date: "2026-08-31",
          product: "Actions",
          sku: "actions_linux",
          quantity: 5,
          grossAmount: 5,
          discountAmount: 0,
          netAmount: 5,
        },
      ],
      range,
      false,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: "Git LFS", amount: 3, usageAmount: 3 });
  });

  it("tags the organization and cost centre on an enterprise bill", () => {
    const [row] = toCostRows(
      [
        {
          date: "2026-09-05",
          product: "copilot",
          sku: "copilot_for_business",
          quantity: 1,
          grossAmount: 19,
          discountAmount: 0,
          netAmount: 19,
          organizationName: "octo-org",
          costCenter: "Platform",
        },
      ],
      range,
      true,
    );
    expect(row).toMatchObject({
      service: "Copilot",
      tags: { sku: "copilot_for_business", organization: "octo-org", costCenter: "Platform" },
    });
  });
});

describe("fetchGitHubCostData", () => {
  it("reads one month per call for an organization", async () => {
    const { http, calls } = makeHttp(() => ({
      body: {
        usageItems: [
          {
            date: "2026-09-10",
            product: "actions",
            sku: "actions_linux",
            quantity: 10,
            grossAmount: 0.06,
            discountAmount: 0,
            netAmount: 0.06,
          },
        ],
      },
    }));
    const rows = await fetchGitHubCostData(ctxWith(http), range);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/organizations/octo-org/settings/billing/usage");
    expect(calls[0]!.url.searchParams.get("year")).toBe("2026");
    expect(calls[0]!.url.searchParams.get("month")).toBe("9");
    expect(rows).toHaveLength(1);
  });

  it("partitions an enterprise bill by cost centre", async () => {
    const { http, calls } = makeHttp((url) => {
      if (url.pathname.endsWith("/cost-centers")) {
        return {
          body: { costCenters: [{ id: "cc1", name: "Platform", state: "active", resources: [] }] },
        };
      }
      const cc = url.searchParams.get("cost_center_id");
      return {
        body: {
          usageItems: [
            {
              date: "2026-09-10",
              product: "actions",
              sku: "actions_linux",
              quantity: 1,
              grossAmount: cc ? 2 : 1,
              discountAmount: 0,
              netAmount: cc ? 2 : 1,
              organizationName: "o",
            },
          ],
        },
      };
    });
    const rows = await fetchGitHubCostData(ctxWith(http, "enterprise:big"), range);
    expect(calls.map((c) => c.url.searchParams.get("cost_center_id"))).toEqual([null, null, "cc1"]);
    expect(rows.map((r) => [r.amount, r.tags?.["costCenter"]])).toEqual([
      [1, undefined],
      [2, "Platform"],
    ]);
  });

  it("skips months before the billing history starts but not the newest", async () => {
    const { http } = makeHttp((url) =>
      url.searchParams.get("month") === "8"
        ? { status: 400, body: { message: "too old" } }
        : { body: { usageItems: [] } },
    );
    await expect(
      fetchGitHubCostData(ctxWith(http), { fromDate: "2026-08-01", toDate: "2026-09-30" }),
    ).resolves.toEqual([]);
  });

  it("turns a 403 into a setup error naming the permission", async () => {
    const { http } = makeHttp(() => ({ status: 403, body: { message: "Must have admin rights" } }));
    const err = await fetchGitHubCostData(ctxWith(http), range).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostSetupError);
    expect((err as Error).message).toContain("Administration (read)");
  });
});
