import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  formatPdfValue,
  niceTicks,
  renderReportPdf,
  textWidth,
  toWinAnsi,
  truncateText,
  wrapText,
  type PdfReportModel,
} from "../pdf";

const decoder = new TextDecoder("latin1");

/** Every content stream in the file, inflated, joined. */
function contentOf(bytes: Uint8Array): string {
  const text = decoder.decode(bytes);
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf("stream\n", at);
    if (start < 0) break;
    const end = text.indexOf("\nendstream", start);
    out.push(inflateSync(Buffer.from(bytes.slice(start + 7, end))).toString("latin1"));
    at = end + 10;
  }
  return out.join("\n");
}

function hex(text: string): string {
  return toWinAnsi(text)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const days = Array.from({ length: 30 }, (_, i) => `Sep ${i + 1}`);

const model: PdfReportModel = {
  title: "Platform costs",
  subtitle: "Weekly review dashboard",
  orgName: "Acme",
  url: "https://app.example.com/org/o1/dashboard/d1",
  notes: ["Amounts converted to USD at the org's stated rates."],
  generatedAt: new Date("2026-10-04T08:00:00Z"),
  timezone: "Europe/Berlin",
  sections: [
    {
      title: "Spend by provider",
      subtitle: "Last 30 days · daily · by provider",
      blocks: [
        {
          kind: "chart",
          chartType: "stacked_bar",
          categories: days,
          series: [
            { label: "AWS", values: days.map((_, i) => 100 + i * 3) },
            { label: "Google Cloud", values: days.map((_, i) => 40 + (i % 5) * 4) },
            { label: "Other", values: days.map(() => 12) },
            {
              label: "Forecast",
              values: days.map((_, i) => (i > 24 ? 190 + i : null)),
              dashed: true,
              overlay: true,
            },
          ],
          format: { currency: "USD" },
        },
        {
          kind: "table",
          columns: ["Group", "Spend"],
          rows: [
            ["AWS", "$4,305"],
            ["Google Cloud", "$1,560"],
          ],
          align: ["left", "right"],
        },
      ],
    },
    {
      title: "Share by service",
      blocks: [
        {
          kind: "pie",
          slices: [
            { label: "EC2", value: 300 },
            { label: "S3", value: 120 },
            { label: "RDS", value: 80 },
          ],
          format: { currency: "EUR" },
        },
      ],
    },
    {
      title: "Line and area",
      blocks: [
        {
          kind: "chart",
          chartType: "line",
          categories: ["a", "b", "c", "d"],
          series: [{ label: "p95 latency", values: [10, null, 12, 9] }],
          format: { unit: "ms" },
        },
        {
          kind: "chart",
          chartType: "area",
          categories: ["a", "b", "c", "d"],
          series: [
            { label: "x", values: [1, 2, 3, 4] },
            { label: "y", values: [2, 2, 2, 2] },
          ],
          format: {},
        },
      ],
    },
    {
      title: "KPIs",
      blocks: [
        {
          kind: "stats",
          items: [
            {
              label: "Month to date",
              value: "$12,340",
              caption: "+8.2% vs last month",
              tone: "bad",
            },
            { label: "Requests", value: "1.2M" },
          ],
        },
      ],
    },
    {
      title: "Production budget",
      blocks: [
        {
          kind: "progress",
          label: "Production budget",
          value: 8200,
          max: 10000,
          projected: 11200,
          markers: [
            { at: 8000, label: "80%" },
            { at: 10000, label: "100%" },
          ],
          caption: "Forecast to overspend by $1,200.",
          format: { currency: "USD" },
        },
      ],
    },
    {
      title: "Pinned resources",
      blocks: [
        {
          kind: "table",
          columns: ["Name", "Type", "Status"],
          rows: Array.from({ length: 70 }, (_, i) => [`server-${i}`, "VM", "running"]),
        },
      ],
    },
  ],
};

describe("pdf fonts", () => {
  it("encodes WinAnsi with substitutions", () => {
    expect(toWinAnsi("A€–→")).toEqual([0x41, 0x80, 0x96, 0x2d, 0x3e]);
    expect(toWinAnsi("日")).toEqual([0x3f]);
  });

  it("measures, truncates and wraps", () => {
    expect(textWidth("ii", 10)).toBeCloseTo(4.44, 2);
    expect(textWidth("W", 10, "bold")).toBeCloseTo(9.44, 2);
    const cut = truncateText("a very long resource name indeed", 60, 10);
    expect(cut.endsWith("…")).toBe(true);
    expect(textWidth(cut, 10)).toBeLessThanOrEqual(60);
    expect(wrapText("one two three four five", 40, 10).length).toBeGreaterThan(1);
  });
});

describe("pdf render helpers", () => {
  it("picks nice ticks", () => {
    expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(-10, 10)[0]).toBeLessThanOrEqual(-10);
  });

  it("formats values", () => {
    expect(formatPdfValue(1234.5, { currency: "USD" })).toBe("$1,235");
    expect(formatPdfValue(12.5, { currency: "USD" })).toBe("$12.50");
    expect(formatPdfValue(1500, { currency: "USD" }, true)).toBe("$1.5K");
    expect(formatPdfValue(42, { unit: "%" })).toBe("42%");
    expect(formatPdfValue(3, { unit: "ms" })).toBe("3 ms");
    expect(formatPdfValue(3, { currency: "CREDITS" })).toBe("3 CREDITS");
  });
});

describe("renderReportPdf", () => {
  const bytes = renderReportPdf(model);
  const text = decoder.decode(bytes);

  if (process.env["PDF_SAMPLE_OUT"]) writeFileSync(process.env["PDF_SAMPLE_OUT"], bytes);

  it("is a structurally valid PDF", () => {
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // The xref offsets point at the objects they name.
    const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    entries.forEach((offset, i) => {
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it("paginates long content and numbers the pages", () => {
    const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)?.[1]);
    expect(pages).toBeGreaterThan(1);
    const content = contentOf(bytes);
    expect(content).toContain(hex(`Page ${pages} of ${pages}`));
  });

  it("draws the titles, legend and link", () => {
    const content = contentOf(bytes);
    expect(content).toContain(hex("Platform costs"));
    expect(content).toContain(hex("Spend by provider"));
    expect(content).toContain(hex("Google Cloud"));
    expect(text).toContain("/URI (https://app.example.com/org/o1/dashboard/d1)");
  });

  it("renders an empty dashboard", () => {
    const empty = renderReportPdf({ ...model, sections: [] });
    expect(contentOf(empty)).toContain(hex("This dashboard has no cards yet."));
  });
});
