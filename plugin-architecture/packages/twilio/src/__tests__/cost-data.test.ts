import { describe, expect, it } from "vitest";
import { fetchTwilioCostData } from "../cost-data.js";
import { MAIN, SUB, ctxWith, makeHttp, page, record } from "./helpers.js";

const RANGE = { fromDate: "2026-09-01", toDate: "2026-09-02" };

/**
 * A fake Usage Records API. `summary[account]` is the per-range record list;
 * `daily[account][category]` the per-day records.
 */
function usageApi(
  summary: Record<string, Array<Record<string, unknown>>>,
  daily: Record<string, Record<string, Array<Record<string, unknown>>>>,
  opts: { includeTotals?: Record<string, Array<Record<string, unknown>>>; denied?: string[] } = {},
) {
  return makeHttp((url) => {
    const m = url.pathname.match(
      /^\/2010-04-01\/Accounts\/(AC\w+)\/Usage\/Records(\/Daily)?\.json$/,
    );
    if (!m) return { status: 404, body: { message: "not found" } };
    const account = m[1] ?? "";
    if (opts.denied?.includes(account))
      return { status: 403, body: { message: "denied", code: 20003 } };
    const include = url.searchParams.get("IncludeSubaccounts") === "true";
    if (!m[2]) return { body: page("usage_records", summary[account] ?? []) };
    const category = url.searchParams.get("Category") ?? "";
    if (include && opts.includeTotals && category === "totalprice") {
      return { body: page("usage_records", opts.includeTotals[account] ?? []) };
    }
    return { body: page("usage_records", daily[account]?.[category] ?? []) };
  });
}

const day = (date: string, category: string, price: number, extra: Record<string, unknown> = {}) =>
  record(category, price, { start_date: date, end_date: date, ...extra });

describe("fetchTwilioCostData", () => {
  it("emits one row per leaf category per day, never the rollups", async () => {
    const { http, calls } = usageApi(
      {
        [MAIN]: [
          record("totalprice", 3),
          record("sms", 2),
          record("sms-outbound", 2),
          record("phonenumbers", 1),
          record("phonenumbers-local", 1),
          record("calls", 0),
        ],
      },
      {
        [MAIN]: {
          totalprice: [day("2026-09-01", "totalprice", 2), day("2026-09-02", "totalprice", 1)],
          "sms-outbound": [
            day("2026-09-01", "sms-outbound", 1, { usage: "125", usage_unit: "segments" }),
            day("2026-09-02", "sms-outbound", 1),
          ],
          "phonenumbers-local": [day("2026-09-01", "phonenumbers-local", 1)],
        },
      },
    );
    const rows = await fetchTwilioCostData(ctxWith(http), RANGE, []);
    expect(rows).toHaveLength(3);
    const sms = rows.find((r) => r.date === "2026-09-01" && r.service === "SMS");
    expect(sms).toMatchObject({
      amount: 1,
      currency: "USD",
      resourceId: MAIN,
      tags: { category: "sms-outbound" },
      usageAmount: 125,
      usageUnit: "segments",
    });
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(3);
    // No daily request for a rollup or an unpriced category.
    const categories = calls.map((c) => c.url.searchParams.get("Category")).filter(Boolean);
    expect(categories).not.toContain("sms");
    expect(categories).not.toContain("calls");
  });

  it("reconciles each day to the billed total in both directions", async () => {
    const { http } = usageApi(
      {
        [MAIN]: [
          record("totalprice", 9),
          record("sms-outbound", 4),
          record("authy-phone-verifications", 4),
        ],
      },
      {
        [MAIN]: {
          totalprice: [day("2026-09-01", "totalprice", 5), day("2026-09-02", "totalprice", 2)],
          "sms-outbound": [
            day("2026-09-01", "sms-outbound", 2),
            day("2026-09-02", "sms-outbound", 2),
          ],
          "authy-phone-verifications": [
            day("2026-09-01", "authy-phone-verifications", 1),
            day("2026-09-02", "authy-phone-verifications", 2),
          ],
        },
      },
    );
    const rows = await fetchTwilioCostData(ctxWith(http), RANGE, []);
    const total = (date: string) =>
      rows.filter((r) => r.date === date).reduce((s, r) => s + r.amount, 0);
    // Day 1: leaves 3 of 5 billed → a 2 "Other" row.
    expect(total("2026-09-01")).toBeCloseTo(5);
    expect(rows.find((r) => r.date === "2026-09-01" && r.service === "Other")?.amount).toBeCloseTo(
      2,
    );
    // Day 2: leaves 4 over 2 billed → scaled down to the bill.
    expect(total("2026-09-02")).toBeCloseTo(2);
    expect(rows.some((r) => r.date === "2026-09-02" && r.service === "Other")).toBe(false);
  });

  it("splits by subaccount with the auth token and reconciles the parent total", async () => {
    const { http } = usageApi(
      {
        [MAIN]: [record("totalprice", 1), record("sms-outbound", 1)],
        [SUB]: [record("totalprice", 2), record("calls-outbound", 2)],
      },
      {
        [MAIN]: {
          totalprice: [day("2026-09-01", "totalprice", 1)],
          "sms-outbound": [day("2026-09-01", "sms-outbound", 1)],
        },
        [SUB]: {
          totalprice: [day("2026-09-01", "totalprice", 2)],
          "calls-outbound": [day("2026-09-01", "calls-outbound", 2)],
        },
      },
      // The parent's IncludeSubaccounts total is 4: 1 is in a subaccount past the cap.
      { includeTotals: { [MAIN]: [day("2026-09-01", "totalprice", 4)] } },
    );
    const rows = await fetchTwilioCostData(ctxWith(http), RANGE, [{ sid: SUB, name: "Acme" }]);
    expect(rows.find((r) => r.service === "Voice")).toMatchObject({
      resourceId: SUB,
      tags: { category: "calls-outbound", subaccount: "Acme" },
    });
    expect(rows.find((r) => r.service === "SMS")?.tags?.["subaccount"]).toBe("(main account)");
    const other = rows.find((r) => r.tags?.["subaccount"] === "Other subaccounts");
    expect(other?.amount).toBeCloseTo(1);
    expect(other?.resourceId).toBeUndefined();
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(4);
  });

  it("folds an unreadable subaccount into Other subaccounts instead of failing", async () => {
    const { http } = usageApi(
      { [MAIN]: [record("totalprice", 1), record("sms-outbound", 1)] },
      {
        [MAIN]: {
          totalprice: [day("2026-09-01", "totalprice", 1)],
          "sms-outbound": [day("2026-09-01", "sms-outbound", 1)],
        },
      },
      { includeTotals: { [MAIN]: [day("2026-09-01", "totalprice", 3)] }, denied: [SUB] },
    );
    const rows = await fetchTwilioCostData(ctxWith(http), RANGE, [{ sid: SUB, name: "Acme" }]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(3);
  });

  it("collects the whole account as one scope with an API key", async () => {
    const { http, calls } = usageApi(
      { [MAIN]: [record("totalprice", 1), record("sms-outbound", 1)] },
      {
        [MAIN]: {
          totalprice: [day("2026-09-01", "totalprice", 1)],
          "sms-outbound": [day("2026-09-01", "sms-outbound", 1)],
        },
      },
    );
    const rows = await fetchTwilioCostData(ctxWith(http, "api-key"), RANGE, [
      { sid: SUB, name: "Acme" },
    ]);
    expect(rows).toHaveLength(1);
    // Subaccounts exist, so the rows include them: no single-account resourceId.
    expect(rows[0]?.resourceId).toBeUndefined();
    expect(calls.every((c) => c.url.pathname.includes(MAIN))).toBe(true);
    expect(calls.every((c) => c.url.searchParams.get("IncludeSubaccounts") === "true")).toBe(true);
    expect(calls[0]?.headers["Authorization"]).toBe(
      `Basic ${btoa("SK00000000000000000000000000000000:secret")}`,
    );
  });

  it("stops after one request for an account with no spend", async () => {
    const { http, calls } = usageApi({ [MAIN]: [record("totalprice", 0)] }, {});
    expect(await fetchTwilioCostData(ctxWith(http), RANGE, [])).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
