/**
 * The palette guard for this app's components, which render ui's `theme.css`.
 * The rules and why they exist are in `@infrawrench/ui/theme-scan`; ui's and
 * desktop's suites run the same scans over their own sources. Keep this file in
 * step with desktop's copy.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PALETTE_TEXT_ADVICE, scanBlueFills, scanPaletteText } from "@infrawrench/ui/theme-scan";

/** This app's `src/`: this file is `src/lib/__tests__/theme-palette.test.ts`. */
const SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe("no blue in the interface", () => {
  it("is true of every component in web", () => {
    const { files, offenders } = scanBlueFills(SRC);
    // A mis-resolved root would otherwise scan nothing and pass.
    expect(files, `no sources found under ${SRC}`).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});

describe("no hardcoded palette text utilities", () => {
  it("is true of every component in web", () => {
    const { files, offenders } = scanPaletteText(SRC);
    // A mis-resolved root would otherwise scan nothing and pass.
    expect(files, `no sources found under ${SRC}`).toBeGreaterThan(50);
    expect(offenders, `web ${PALETTE_TEXT_ADVICE}`).toEqual([]);
  });
});
