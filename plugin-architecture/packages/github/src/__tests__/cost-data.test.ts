import { CostSetupError } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { fetchGitHubCostData, toCostRows } from "../cost-data.js";
import { monthsBetween } from "../usage.js";
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
    expect(calls.map((c) => c.url.searchParams.get("cost_center_id"))).toEqual([
      null,
      null,
      null,
      "cc1",
    ]);
    expect(rows.map((r) => [r.amount, r.tags?.["costCenter"]])).toEqual([
      [1, undefined],
      [2, "Platform"],
    ]);
  });

  describe("a deleted cost centre", () => {
    const line = (sku: string, amount: number, net = amount) => ({
      date: "2026-09-10",
      product: "actions",
      sku,
      quantity: 1,
      grossAmount: amount,
      discountAmount: amount - net,
      netAmount: net,
      organizationName: "o",
    });
    const total = (sku: string, amount: number, net = amount) => ({
      product: "Actions",
      sku,
      grossAmount: amount,
      netAmount: net,
    });

    /** `outside` is the default read, `dead` the deleted centre's and `bill` the whole month's. */
    const bill = (reply: {
      outside: unknown[];
      dead?: unknown[];
      deadStatus?: number;
      summary?: unknown[];
      summaryStatus?: number;
      deletedListStatus?: number;
    }) =>
      makeHttp((url) => {
        if (url.pathname.endsWith("/cost-centers")) {
          if (url.searchParams.get("state") !== "deleted") return { body: { costCenters: [] } };
          if (reply.deletedListStatus) {
            return { status: reply.deletedListStatus, body: { message: "no" } };
          }
          return {
            body: { costCenters: [{ id: "dead", name: "Old", state: "deleted", resources: [] }] },
          };
        }
        if (url.pathname.endsWith("/usage/summary")) {
          if (reply.summaryStatus) return { status: reply.summaryStatus, body: { message: "no" } };
          return { body: { usageItems: reply.summary ?? [] } };
        }
        if (url.searchParams.get("cost_center_id") === "dead") {
          if (reply.deadStatus) return { status: reply.deadStatus, body: { message: "no" } };
          return { body: { usageItems: reply.dead ?? [] } };
        }
        return { body: { usageItems: reply.outside } };
      });
    const read = (http: ReturnType<typeof bill>["http"]) =>
      fetchGitHubCostData(ctxWith(http, "enterprise:big"), range);
    const usageAmounts = (rows: Awaited<ReturnType<typeof read>>) =>
      rows.filter((r) => r.chargeType === "usage").map((r) => [r.amount, r.tags?.["costCenter"]]);

    it("adds its usage when the whole bill shows the read is short by exactly that", async () => {
      const { http, calls } = bill({
        outside: [line("actions_linux", 1)],
        dead: [line("actions_linux", 2)],
        // The summary spells its identifiers its own way, and the two still have to meet.
        summary: [total("Actions Linux", 3)],
      });
      expect(usageAmounts(await read(http))).toEqual([
        [1, undefined],
        [2, "Old"],
      ]);
      expect(calls.find((c) => c.url.searchParams.get("state") === "deleted")?.url.pathname).toBe(
        "/enterprises/big/settings/billing/cost-centers",
      );
    });

    it("does not ask for it when the read already matches the whole bill", async () => {
      const { http, calls } = bill({
        outside: [line("actions_linux", 3)],
        dead: [line("actions_linux", 3)],
        summary: [total("actions_linux", 3)],
      });
      expect(usageAmounts(await read(http))).toEqual([[3, undefined]]);
      expect(calls.some((c) => c.url.searchParams.get("cost_center_id") === "dead")).toBe(false);
    });

    it("does not add usage the default read already holds, whatever else the bill is short of", async () => {
      const { http } = bill({
        outside: [line("actions_linux", 2), line("actions_macos", 5)],
        dead: [line("actions_linux", 2)],
        // Short on macOS for some other reason. Linux is already whole.
        summary: [total("actions_linux", 2), total("actions_macos", 9)],
      });
      expect(usageAmounts(await read(http))).toEqual([
        [2, undefined],
        [5, undefined],
      ]);
    });

    it("compares per SKU, so a gap elsewhere cannot excuse a SKU that is already whole", async () => {
      const { http } = bill({
        outside: [line("actions_linux", 1)],
        dead: [line("actions_linux", 2)],
        summary: [total("actions_linux", 1), total("actions_macos", 2)],
      });
      expect(usageAmounts(await read(http))).toEqual([[1, undefined]]);
    });

    it("adds nothing when only part of its usage reconciles", async () => {
      const { http } = bill({
        outside: [line("actions_linux", 1), line("actions_macos", 2)],
        dead: [line("actions_linux", 4), line("actions_macos", 4)],
        summary: [total("actions_linux", 5), total("actions_macos", 2)],
      });
      expect(usageAmounts(await read(http))).toEqual([
        [1, undefined],
        [2, undefined],
      ]);
    });

    it("needs the net to reconcile as well as the gross", async () => {
      const { http } = bill({
        outside: [line("actions_linux", 1)],
        dead: [line("actions_linux", 2, 0)],
        summary: [total("actions_linux", 3, 3)],
      });
      expect(usageAmounts(await read(http))).toEqual([[1, undefined]]);
    });

    it("adds nothing when only a rounding error could tell the two apart", async () => {
      const { http } = bill({
        outside: [line("actions_linux", 1), line("actions_macos", 5)],
        dead: [line("actions_linux", 0.004)],
        summary: [total("actions_linux", 1), total("actions_macos", 9)],
      });
      expect(usageAmounts(await read(http))).toEqual([
        [1, undefined],
        [5, undefined],
      ]);
    });

    it("lets a line too small to prove anything through beside one that proves it", async () => {
      const { http } = bill({
        outside: [line("actions_linux", 1)],
        dead: [line("actions_linux", 2), line("actions_storage", 0.004)],
        summary: [total("actions_linux", 3)],
      });
      expect(usageAmounts(await read(http))).toEqual([
        [1, undefined],
        [2, "Old"],
        [0.004, "Old"],
      ]);
    });

    it("keeps the read as it was when GitHub will not give the whole bill", async () => {
      const { http } = bill({
        outside: [line("actions_linux", 1)],
        dead: [line("actions_linux", 2)],
        summaryStatus: 400,
      });
      expect(usageAmounts(await read(http))).toEqual([[1, undefined]]);
    });

    it("keeps the read as it was when the deleted centre's usage is refused", async () => {
      const { http } = bill({
        outside: [line("actions_linux", 1)],
        deadStatus: 400,
        summary: [total("actions_linux", 3)],
      });
      expect(usageAmounts(await read(http))).toEqual([[1, undefined]]);
    });

    it("keeps the read as it was when deleted centres cannot be listed that way", async () => {
      const { http } = bill({ outside: [line("actions_linux", 1)], deletedListStatus: 400 });
      expect(usageAmounts(await read(http))).toEqual([[1, undefined]]);
    });

    it.each([
      ["the whole bill", { summaryStatus: 500 }],
      ["the deleted centre's usage", { deadStatus: 500, summary: [total("actions_linux", 3)] }],
      ["the deleted centres", { deletedListStatus: 500 }],
    ])("throws when %s fails, so the stored rows stay", async (_what, failure) => {
      const { http } = bill({ outside: [line("actions_linux", 1)], ...failure });
      await expect(read(http)).rejects.toThrow("500");
    });

    it("never treats an active centre the deleted list hands back as deleted", async () => {
      const { http, calls } = makeHttp((url) => {
        if (url.pathname.endsWith("/cost-centers")) {
          return { body: { costCenters: [{ id: "cc1", name: "Live", state: "active" }] } };
        }
        return { body: { usageItems: [line("actions_linux", 1)] } };
      });
      await read(http);
      expect(calls.filter((c) => c.url.searchParams.get("cost_center_id") === "cc1")).toHaveLength(
        1,
      );
    });
  });

  describe("when the cost centres cannot be read", () => {
    const withCentres = (reply: { status?: number; body: unknown }) =>
      makeHttp((url) =>
        url.pathname.endsWith("/cost-centers")
          ? reply
          : {
              body: {
                usageItems: [
                  { date: "2026-09-10", product: "actions", sku: "actions_linux", grossAmount: 1 },
                ],
              },
            },
      );

    it("throws, since usage under a centre is only read by asking for that centre", async () => {
      const { http } = withCentres({ status: 500, body: { message: "boom" } });
      await expect(fetchGitHubCostData(ctxWith(http, "enterprise:big"), range)).rejects.toThrow(
        "500",
      );
    });

    it("throws on an answer with its key renamed", async () => {
      const { http } = withCentres({ body: { items: [] } });
      await expect(fetchGitHubCostData(ctxWith(http, "enterprise:big"), range)).rejects.toThrow(
        "is not a list",
      );
    });

    it("reads a 404 as an enterprise with none", async () => {
      const { http } = withCentres({ status: 404, body: { message: "Not Found" } });
      const rows = await fetchGitHubCostData(ctxWith(http, "enterprise:big"), range);
      expect(rows.map((r) => r.amount)).toEqual([1]);
    });
  });

  it("throws on a usage answer with its key renamed, rather than read an empty bill", async () => {
    const { http } = makeHttp(() => ({ body: { items: [] } }));
    await expect(fetchGitHubCostData(ctxWith(http), range)).rejects.toThrow("is not a list");
  });

  it("reads a usage answer holding nothing as an empty month", async () => {
    const { http } = makeHttp(() => ({ body: {} }));
    expect(await fetchGitHubCostData(ctxWith(http), range)).toEqual([]);
  });

  it("keeps the newest months of a very long range", () => {
    const months = monthsBetween("2015-01-01", "2026-03-15");
    expect(months).toHaveLength(135);
    expect(months.at(-1)).toEqual({ year: 2026, month: 3 });
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
