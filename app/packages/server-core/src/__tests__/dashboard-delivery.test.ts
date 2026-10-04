import { describe, expect, it, vi } from "vitest";
import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const { dashboardDeliverySegments, dashboardDeliveryTitle, MAX_DASHBOARD_HIGHLIGHTS } =
  await import("../report-delivery/dashboard");

const flat = (lines: ReturnType<typeof dashboardDeliverySegments>) =>
  lines.map((l) => l.map((s) => s.text).join(""));

describe("dashboard delivery composition", () => {
  it("titles the message with the dashboard and the local date", () => {
    const now = new Date("2026-10-04T23:30:00Z");
    expect(dashboardDeliveryTitle("Platform", now, "UTC")).toBe("Platform · Oct 4");
    // The schedule's own zone decides the date, not the server's.
    expect(dashboardDeliveryTitle("Platform", now, "Asia/Tokyo")).toBe("Platform · Oct 5");
    expect(dashboardDeliveryTitle("Platform", now, "Not/AZone")).toBe("Platform · Oct 4");
  });

  it("quotes the highlights and says where the PDF went", () => {
    const lines = flat(
      dashboardDeliverySegments(
        { highlights: ["Spend: $10", "Budget: $5 of $10 (50%)"] },
        "The full dashboard is attached as platform.pdf.",
      ),
    );
    expect(lines).toEqual([
      "• Spend: $10",
      "• Budget: $5 of $10 (50%)",
      "",
      "The full dashboard is attached as platform.pdf.",
    ]);
  });

  it("bounds the highlights and counts the rest", () => {
    const highlights = Array.from({ length: MAX_DASHBOARD_HIGHLIGHTS + 3 }, (_, i) => `Card ${i}`);
    const lines = flat(dashboardDeliverySegments({ highlights }, null));
    expect(lines).toHaveLength(MAX_DASHBOARD_HIGHLIGHTS + 1);
    expect(lines.at(-1)).toBe("…and 3 more card(s).");
  });

  it("still says something for a dashboard with nothing to quote", () => {
    const lines = flat(dashboardDeliverySegments({ highlights: [] }, null));
    expect(lines[0]).toMatch(/no cards with a figure/);
  });
});
