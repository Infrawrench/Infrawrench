import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

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
 * The second check reaches outside this package on purpose: `theme.css` is
 * defined here but `web` and `desktop` consume it, so a guard that watched
 * only `ui` would let the defect back in through either host.
 */

/**
 * The workspace root, found by walking up from the cwd rather than assuming
 * one: `vitest` run inside the package and `turbo test` from the repo root
 * disagree about what the cwd is, and a path that silently resolves to
 * nothing would make the palette scan pass by scanning zero files.
 */
function workspaceRoot(): string {
  let dir = cwd();
  for (let up = 0; up < 10; up++) {
    if (existsSync(`${dir}/pnpm-workspace.yaml`)) return dir;
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    if (parent === "" || parent === dir) break;
    dir = parent;
  }
  throw new Error(`no pnpm-workspace.yaml above ${cwd()}`);
}

const ROOT = workspaceRoot();
const themeCss = readFileSync(`${ROOT}/app/packages/ui/src/theme.css`, "utf8");

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

describe("no hardcoded palette text utilities", () => {
  const PALETTE =
    /\btext-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

  /**
   * `mobile` is deliberately absent: it is dark-only and styles from a named
   * token object (`mobile/src/lib/theme.ts`), not Tailwind, so it has no
   * palette classes to regress. `theme.css` is likewise out of reach — only
   * `.ts`/`.tsx` are read, so the comment there that names the old classes
   * for the reader does not trip the scan.
   */
  const SCANNED = ["ui", "web", "desktop"].map((pkg) => `app/packages/${pkg}/src`);

  function* sources(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") yield* sources(path);
      } else if (/\.tsx?$/.test(entry.name)) {
        yield path;
      }
    }
  }

  it.each(SCANNED)("is true of every component in %s", (relative) => {
    const files = [...sources(`${ROOT}/${relative}`)];
    // A mis-resolved root would otherwise scan nothing and pass.
    expect(files.length, `no sources found under ${relative}`).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const hit = PALETTE.exec(line);
          if (hit) offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1} → ${hit[0]}`);
        });
    }
    expect(
      offenders,
      `${relative} uses fixed palette text colours, which cannot clear WCAG AA in both schemes — replace each with a semantic token (text-danger / text-warning / text-success / text-info / text-severe / text-notice / text-series-N)`,
    ).toEqual([]);
  });
});
