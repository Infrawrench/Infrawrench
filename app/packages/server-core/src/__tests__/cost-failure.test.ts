import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { describeCostFailure } from "../cost/failure";

describe("describeCostFailure", () => {
  it("keeps a plain error's message and reports no link", () => {
    expect(describeCostFailure(new Error("BigQuery job failed: 403"))).toEqual({
      message: "BigQuery job failed: 403",
      helpLink: null,
    });
  });

  it("carries the help link off a CostSetupError", () => {
    const e = new CostSetupError("Billing export isn't enabled.", {
      label: "Enable billing export",
      url: "https://console.cloud.google.com/billing/export?project=p",
    });
    expect(describeCostFailure(e)).toEqual({
      message: "Billing export isn't enabled.",
      helpLink: {
        label: "Enable billing export",
        url: "https://console.cloud.google.com/billing/export?project=p",
      },
    });
  });

  it("matches CostSetupError structurally, since plugins bundle their own copy", () => {
    const fromOtherRealm = Object.assign(new Error("Configure the export table."), {
      name: "CostSetupError",
      helpLink: { label: "Docs", url: "https://example.com/setup" },
    });
    expect(describeCostFailure(fromOtherRealm).helpLink).toEqual({
      label: "Docs",
      url: "https://example.com/setup",
    });
  });

  it("drops a link that isn't https so the UI never renders javascript: or http:", () => {
    for (const url of ["javascript:alert(1)", "http://example.com", "/relative"]) {
      const e = new CostSetupError("nope", { label: "Fix", url });
      expect(describeCostFailure(e).helpLink).toBeNull();
    }
  });

  it("ignores a help link on an ordinary error", () => {
    const e = Object.assign(new Error("boom"), {
      helpLink: { label: "Fix", url: "https://example.com" },
    });
    expect(describeCostFailure(e).helpLink).toBeNull();
  });

  it("truncates a runaway provider message", () => {
    const { message } = describeCostFailure(new Error("x".repeat(5_000)));
    expect(message).toHaveLength(600);
    expect(message.endsWith("…")).toBe(true);
  });

  it("falls back for non-Error throws and empty messages", () => {
    expect(describeCostFailure("string failure").message).toBe("string failure");
    expect(describeCostFailure(new Error("   ")).message).toBe("Unknown error");
  });
});
