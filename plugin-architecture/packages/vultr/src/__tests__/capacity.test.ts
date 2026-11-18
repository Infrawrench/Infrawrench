import { describe, expect, it } from "vitest";
import { mapAccount } from "../listers.js";

describe("bandwidth pool", () => {
  it("stores outbound GB this month against the sum of every credit", () => {
    const account = mapAccount({ name: "acme" }, "acct", {
      current_month_to_date: {
        gb_out: 120,
        instance_bandwidth_credits: 1000,
        free_bandwidth_credits: 2048,
        purchased_bandwidth_credits: 0,
      },
    });
    expect(account.fields["bandwidthGbOut"]).toBe(120);
    expect(account.fields["bandwidthCreditsGb"]).toBe(3048);
  });

  it("leaves both out when the bandwidth read failed", () => {
    const account = mapAccount({ name: "acme" }, "acct", null);
    expect(account.fields["bandwidthGbOut"]).toBeUndefined();
    expect(account.fields["bandwidthCreditsGb"]).toBeUndefined();
  });
});
