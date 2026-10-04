import { afterEach, describe, expect, it, vi } from "vitest";
import { pdfFileName, withPdfTimezone } from "../report-notifications";

describe("pdfFileName", () => {
  it("slugs the name", () => {
    expect(pdfFileName("Monthly spend")).toBe("monthly-spend.pdf");
    expect(pdfFileName("Platform · Costs (EU)")).toBe("platform-costs-eu.pdf");
    expect(pdfFileName("Café Ops")).toBe("cafe-ops.pdf");
  });

  it("falls back when nothing survives, and bounds the length", () => {
    expect(pdfFileName("日本語")).toBe("infrawrench-export.pdf");
    expect(pdfFileName("   ", "dashboard")).toBe("dashboard.pdf");
    const long = pdfFileName(`${"ab ".repeat(60)}`);
    expect(long.length).toBeLessThanOrEqual(84);
    expect(long.endsWith("-.pdf")).toBe(false);
  });
});

describe("withPdfTimezone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends the local zone, respecting an existing query", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Europe/Berlin",
    } as Intl.ResolvedDateTimeFormatOptions);
    expect(withPdfTimezone("/dashboards/d1/pdf")).toBe("/dashboards/d1/pdf?tz=Europe%2FBerlin");
    expect(withPdfTimezone("/x/pdf?a=1")).toBe("/x/pdf?a=1&tz=Europe%2FBerlin");
  });

  it("leaves the path alone without a zone", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "",
    } as Intl.ResolvedDateTimeFormatOptions);
    expect(withPdfTimezone("/x/pdf")).toBe("/x/pdf");
  });
});
