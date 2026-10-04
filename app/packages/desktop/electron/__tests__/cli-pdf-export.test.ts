import { beforeAll, describe, expect, it } from "vitest";

import { formatBytes, pdfFileName } from "../cli/format";

// The CLI keeps a local copy of client-core's `pdfFileName` because its
// client-core imports are type-only (zero runtime dependencies). This pins the
// copy to the original, so `--format pdf` writes the same name the web and
// desktop downloads use. Imported dynamically: this test compiles as
// CommonJS and client-core is ESM.
let sharedPdfFileName: (name: string, fallback?: string) => string;
beforeAll(async () => {
  ({ pdfFileName: sharedPdfFileName } = await import("@infrawrench/client-core"));
});

describe("cli pdfFileName", () => {
  it.each(["Monthly spend", "Platform · Costs (EU)", "Café Ops", "   ", "a".repeat(120), "日本語"])(
    "matches client-core for %j",
    (name) => {
      expect(pdfFileName(name)).toBe(sharedPdfFileName(name));
      expect(pdfFileName(name, "dashboard")).toBe(sharedPdfFileName(name, "dashboard"));
    },
  );
});

describe("cli formatBytes", () => {
  it("scales to the largest whole unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toMatch(/^512 B$/);
    expect(formatBytes(48_000)).toMatch(/KB$/);
  });
});
