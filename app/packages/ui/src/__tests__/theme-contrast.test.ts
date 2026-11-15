import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PALETTE_TEXT_ADVICE, scanBlueFills, scanPaletteText } from "../theme-scan";

/**
 * WCAG AA contrast guard for the semantic colour tokens.
 *
 * The values live in `theme.css` and are parsed out of it here rather than
 * duplicated, so this test fails when the stylesheet changes rather than
 * when someone remembers to update a fixture.
 *
 * Two things are enforced:
 *
 *  1. Every foreground token clears 4.5:1 against *all four* surfaces in
 *     *both* schemes. The four-surface part is the bit that used to be
 *     missing: `--color-on-surface-faint` cleared AA on `surface` and
 *     `surface-raised` and was 4.39:1 on `surface-overlay` and 3.90:1 on
 *     `surface-sunken`, which are the backgrounds of half the app's chips,
 *     tables and popovers.
 *  2. No `text-<palette>-<shade>` utility comes back, in **any** of the three
 *     packages that render this stylesheet. A Tailwind palette class is one
 *     fixed colour in both schemes, so it can only be legible in one of them;
 *     the tokens above exist so nobody has to pick.
 *
 * `theme.css` is defined here but `web` and `desktop` consume it, so a guard
 * that watched only `ui` would let the defect back in through either host.
 * Each app therefore runs the second check over its own `src/` in its own
 * suite (`theme-palette.test.ts`), with the rules in `../theme-scan.ts`; this
 * file scans `ui`. It used to scan all three, which reran this package's
 * whole suite on Infrawrench CI for any change to either app.
 */

/**
 * This package's `src/`, from where this file is rather than from the cwd:
 * `vitest` run inside the package and `turbo test` from the repo root
 * disagree about what the cwd is, and a path that silently resolves to
 * nothing would make the palette scan pass by scanning zero files.
 */
const UI_SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const themeCss = readFileSync(`${UI_SRC}/theme.css`, "utf8");

/** `--color-x: #rrggbb;` pairs inside a slice of the stylesheet. */
function parseVars(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    out[m[1]!] = m[2]!.toLowerCase();
  }
  return out;
}

/** The brace-balanced block introduced by `marker`. */
function block(marker: string): string {
  const start = themeCss.indexOf(marker);
  if (start < 0) throw new Error(`${marker} not found in theme.css`);
  const from = themeCss.indexOf("{", start);
  let depth = 0;
  for (let i = from; i < themeCss.length; i++) {
    if (themeCss[i] === "{") depth++;
    else if (themeCss[i] === "}" && --depth === 0) return themeCss.slice(from, i);
  }
  throw new Error(`unbalanced block for ${marker}`);
}

const lightVars = parseVars(block("@theme"));
const darkVars = { ...lightVars, ...parseVars(block("@media (prefers-color-scheme: dark)")) };
/**
 * The sidebar follows the scheme: a block of its own for the light scheme and
 * a second one, inside a dark media query, for the dark scheme. Each is read
 * over the page's values for that scheme, which is what the cascade does.
 */
const sidebarLightVars = { ...lightVars, ...parseVars(block(".surface-sidebar {")) };
const sidebarDarkBlock = themeCss.slice(
  themeCss.indexOf(".surface-sidebar {", themeCss.indexOf(".surface-sidebar {") + 1),
);
const sidebarDarkOwnVars = parseVars(sidebarDarkBlock.slice(0, sidebarDarkBlock.indexOf("}")));
const sidebarDarkVars = { ...darkVars, ...sidebarDarkOwnVars };

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** WCAG 2.x contrast ratio, 1:1 to 21:1. */
function contrastRatio(a: string, b: string): number {
  const sorted = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (sorted[0]! + 0.05) / (sorted[1]! + 0.05);
}

const SURFACE_TOKENS = ["surface", "surface-raised", "surface-overlay", "surface-sunken"] as const;

/** Foreground tokens that carry text and therefore owe AA on every surface. */
const FOREGROUND_TOKENS = [
  "on-surface",
  "on-surface-secondary",
  "on-surface-tertiary",
  "on-surface-muted",
  "on-surface-faint",
  "danger",
  "danger-strong",
  "warning",
  "warning-strong",
  "success",
  "success-strong",
  "info",
  "info-strong",
  "severe",
  "notice",
  "series-1",
  "series-2",
  "series-3",
  "series-4",
  "series-5",
  "series-6",
  "series-7",
  "series-8",
] as const;

const AA = 4.5;

describe.each([
  ["light", lightVars],
  ["dark", darkVars],
  ["sidebar light", sidebarLightVars],
  ["sidebar dark", sidebarDarkVars],
])("%s scheme", (scheme, vars) => {
  it("defines every surface and foreground token", () => {
    for (const token of [...SURFACE_TOKENS, ...FOREGROUND_TOKENS]) {
      expect(vars[token], `--color-${token} missing in ${scheme}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it.each(FOREGROUND_TOKENS)("--color-%s clears WCAG AA on all four surfaces", (token) => {
    const fg = vars[token]!;
    for (const surface of SURFACE_TOKENS) {
      const ratio = contrastRatio(fg, vars[surface]!);
      expect(
        Number(ratio.toFixed(2)),
        `${scheme} --color-${token} (${fg}) on --color-${surface} (${vars[surface]})`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe("sidebar scope", () => {
  // The dark block sits on surfaces darker than the page's, so a text token it
  // left out would inherit one tuned for a lighter surface.
  it.each([...SURFACE_TOKENS, ...FOREGROUND_TOKENS.filter((t) => !t.startsWith("series-"))])(
    "sets --color-%s itself in the dark scheme",
    (token) => {
      expect(sidebarDarkOwnVars[token]).toMatch(/^#[0-9a-f]{6}$/);
    },
  );

  it("follows the colour scheme rather than forcing dark", () => {
    const first = themeCss.indexOf(".surface-sidebar {");
    const second = themeCss.indexOf(".surface-sidebar {", first + 1);
    expect(second).toBeGreaterThan(first);
    // The second block is the dark one, and only applies in the dark scheme.
    const lastDarkMedia = themeCss.lastIndexOf("@media (prefers-color-scheme: dark)", second);
    expect(themeCss.slice(lastDarkMedia, second)).not.toContain("}");
    expect(block(".surface-sidebar {")).not.toContain("color-scheme");
  });
});

describe("accent fills", () => {
  // `text-on-accent` sits on solid accent fills (primary buttons), not on the
  // surfaces, so it gets its own check: AA against the accent it is paired
  // with and against the hover shade the same button transitions to. This
  // token not existing was the original defect: the utility silently compiled
  // to nothing and the label inherited white onto dark mode's light-blue
  // accent.
  it.each([
    ["light", lightVars],
    ["dark", darkVars],
    ["sidebar light", sidebarLightVars],
    ["sidebar dark", sidebarDarkVars],
  ])("%s --color-on-accent clears WCAG AA on accent and accent-hover", (scheme, vars) => {
    expect(vars["on-accent"], `--color-on-accent missing in ${scheme}`).toMatch(/^#[0-9a-f]{6}$/);
    for (const fill of ["accent", "accent-hover"]) {
      const ratio = contrastRatio(vars["on-accent"]!, vars[fill]!);
      expect(
        Number(ratio.toFixed(2)),
        `${scheme} --color-on-accent (${vars["on-accent"]}) on --color-${fill} (${vars[fill]})`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe("token hierarchy", () => {
  // Prominence order has to survive the contrast fix: a "faint" label that
  // out-contrasts a "tertiary" one next to it reads as the more important of
  // the two, which is backwards.
  it.each([
    ["light", lightVars],
    ["dark", darkVars],
  ])("%s keeps tertiary >= muted >= faint in contrast", (_scheme, vars) => {
    const on = (t: string) => contrastRatio(vars[t]!, vars["surface"]!);
    expect(on("on-surface-tertiary")).toBeGreaterThanOrEqual(on("on-surface-muted"));
    expect(on("on-surface-muted")).toBeGreaterThanOrEqual(on("on-surface-faint"));
  });

  // `-strong` is the higher-emphasis step, whichever direction that is in:
  // darker than the base in light mode, lighter in dark mode.
  it.each(["danger", "warning", "success", "info"])(
    "%s-strong out-contrasts its base in both schemes",
    (family) => {
      for (const vars of [lightVars, darkVars]) {
        const base = contrastRatio(vars[family]!, vars["surface"]!);
        const strong = contrastRatio(vars[`${family}-strong`]!, vars["surface"]!);
        expect(strong).toBeGreaterThan(base);
      }
    },
  );
});

describe("no blue in the interface", () => {
  it("is true of every component in ui", () => {
    const { files, offenders } = scanBlueFills(UI_SRC);
    // A mis-resolved root would otherwise scan nothing and pass.
    expect(files, `no sources found under ${UI_SRC}`).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});

describe("no hardcoded palette text utilities", () => {
  /**
   * `mobile` has no scan: it is dark-only and styles from a named token
   * object (`mobile/src/lib/theme.ts`), not Tailwind, so it has no palette
   * classes to regress.
   */
  it("is true of every component in ui", () => {
    const { files, offenders } = scanPaletteText(UI_SRC);
    // A mis-resolved root would otherwise scan nothing and pass.
    expect(files, `no sources found under ${UI_SRC}`).toBeGreaterThan(50);
    expect(offenders, `ui ${PALETTE_TEXT_ADVICE}`).toEqual([]);
  });
});
