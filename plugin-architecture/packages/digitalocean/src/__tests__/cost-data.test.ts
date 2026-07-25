import { describe, expect, it, vi } from "vitest";
import { fetchDoCostData } from "../cost-data.js";

const RANGE = { fromDate: "2025-07-25", toDate: "2025-07-31" };
const ACCOUNT = { account: { team: { uuid: "ca6b655d-079f-424f-a6c6-a4da02efa5cc" } } };

/** `/account` always resolves; the insights call is what each test varies. */
function ctxWith(insights: () => Promise<unknown>) {
  const fetch = vi.fn((path: string) =>
    path === "/account" ? Promise.resolve(ACCOUNT) : insights(),
  );
  return { ctx: { fetch: fetch as never }, fetch };
}

describe("fetchDoCostData", () => {
  it("aggregates data points per (day, service, region)", async () => {
    const { ctx } = ctxWith(() =>
      Promise.resolve({
        total_pages: 1,
        data_points: [
          {
            start_date: "2026-01-02",
            total_amount: "1.50",
            region: "nyc1",
            group_description: "prod-cluster",
          },
          {
            start_date: "2026-01-02",
            total_amount: "2.25",
            region: "nyc1",
            group_description: "prod-cluster",
          },
        ],
      }),
    );

    await expect(fetchDoCostData(ctx, RANGE)).resolves.toEqual([
      {
        date: "2026-01-02",
        service: "prod-cluster",
        region: "nyc1",
        currency: "USD",
        amount: 3.75,
      },
    ]);
  });

  // Regression: the backfill starts a year back, but DO's insights endpoint
  // only holds data from 2025-12-01 and rejects earlier starts with a 400.
  // This used to escape as a hard failure on every cost tick.
  it("treats a pre-2025-12-01 start date 400 as no data", async () => {
    const { ctx } = ctxWith(() =>
      Promise.reject(
        new Error(
          'DO API error 400 for /billing/do:team:ca6b655d/insights/2025-07-25/2025-07-31?per_page=200&page=1: {"error":"Bad Request","messages":{"base":["Start date cannot be before December 1, 2025."]}}',
        ),
      ),
    );

    await expect(fetchDoCostData(ctx, RANGE)).resolves.toEqual([]);
  });

  it("treats a 404 window as no data", async () => {
    const { ctx } = ctxWith(() => Promise.reject(new Error("DO API error 404 for /billing/...")));

    await expect(fetchDoCostData(ctx, RANGE)).resolves.toEqual([]);
  });

  // Swallowing every 400 would report "no spend" for genuinely broken
  // requests, so only the dated-range message is absorbed.
  it("propagates an unrelated 400", async () => {
    const { ctx } = ctxWith(() =>
      Promise.reject(new Error('DO API error 400 for /billing/...: {"error":"Bad Request"}')),
    );

    await expect(fetchDoCostData(ctx, RANGE)).rejects.toThrow("400");
  });

  it("propagates a missing billing:read scope as a real failure", async () => {
    const { ctx } = ctxWith(() => Promise.reject(new Error("DO API error 401 for /billing/...")));

    await expect(fetchDoCostData(ctx, RANGE)).rejects.toThrow("401");
  });

  it("fails clearly when the token has no team context", async () => {
    const fetch = vi.fn(() => Promise.resolve({ account: {} }));
    await expect(fetchDoCostData({ fetch: fetch as never }, RANGE)).rejects.toThrow(
      /no team context/,
    );
  });
});
