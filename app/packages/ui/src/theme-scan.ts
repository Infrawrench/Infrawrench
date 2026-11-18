import { readdirSync, readFileSync } from "node:fs";

/**
 * The scans that keep fixed palette colours out of the components that render
 * `theme.css`: ui, web and desktop. Each of the three runs them over its own
 * `src/` in its own test suite (`theme-contrast.test.ts` here,
 * `theme-palette.test.ts` in the apps), so a change to one app reruns that
 * app's tests and not this package's. The rules live here, beside the
 * stylesheet they guard, and reach the apps as `@infrawrench/ui/theme-scan`.
 *
 * Node only (it reads the file system): import it from tests, never from a
 * component or the barrel.
 */

/**
 * Accent is grey. A blue fill is not just the wrong hue: its hardcoded
 * `text-white` label also goes unreadable the moment it is swapped for the
 * accent, whose dark mode fill is light. Use the accent tokens.
 */
const BLUE_FILL =
  /(?<![\w-])(?:bg|border|ring|accent|shadow|from|via|to|fill|stroke|outline|divide)-(?:blue|sky|indigo)-\d{2,3}\b/;

/**
 * A Tailwind palette class is one fixed colour in both schemes, so it can only
 * be legible in one of them; the semantic tokens exist so nobody has to pick.
 */
const PALETTE_TEXT =
  /\btext-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

export interface ThemeScan {
  /** How many `.ts` and `.tsx` files were read. */
  files: number;
  /** `path:line → class`, the path relative to the directory scanned. */
  offenders: string[];
}

/** Every `.ts` and `.tsx` file under `dir`, leaving out the directories named. */
function* sources(dir: string, skip: readonly string[]): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skip.includes(entry.name)) yield* sources(path, skip);
    } else if (/\.tsx?$/.test(entry.name)) {
      yield path;
    }
  }
}

function scan(src: string, pattern: RegExp, skip: readonly string[]): ThemeScan {
  const root = src.replace(/\/+$/, "");
  const offenders: string[] = [];
  let files = 0;
  for (const file of sources(root, skip)) {
    files++;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const hit = pattern.exec(line);
        if (hit) offenders.push(`${file.slice(root.length + 1)}:${i + 1} → ${hit[0]}`);
      });
  }
  return { files, offenders };
}

/**
 * Blue, sky and indigo fills, borders and rings in the components under `src`.
 * `mcp/` is left out: it renders inside third-party AI clients, under its own
 * theme.
 */
export function scanBlueFills(src: string): ThemeScan {
  return scan(src, BLUE_FILL, ["__tests__", "mcp"]);
}

/**
 * `text-<palette>-<shade>` utilities in the components under `src`. Only
 * `.ts` and `.tsx` are read, so the comment in `theme.css` that names the old
 * classes for the reader does not trip the scan.
 */
export function scanPaletteText(src: string): ThemeScan {
  return scan(src, PALETTE_TEXT, ["__tests__"]);
}

/**
 * A colour utility naming one of the theme's token families: status, surface,
 * accent, border or series. Tailwind v4 generates a colour utility only for a
 * `--color-*` token that exists, so a `danger-surface` background with no
 * `--color-danger-surface` compiles to nothing and fails silently. The group
 * is the token name; an opacity suffix (`/10`) is not part of it.
 */
const TOKEN_UTILITY =
  /(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|from|via|to|divide|decoration|placeholder|caret)-((?:on-)?(?:surface|accent|border|danger|warning|success|info|severe|notice|series)(?:-[a-z0-9]+)*)(?![\w-])/g;

/** Every `--color-*` name `css` defines, in any block. */
export function themeColorTokens(css: string): Set<string> {
  return new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

/**
 * Colour utilities under `src` naming a theme token that `themeCss` does not
 * define. They render as no style at all, with nothing to say so.
 */
export function scanUndefinedTokens(src: string, themeCss: string): ThemeScan {
  const defined = themeColorTokens(themeCss);
  const root = src.replace(/\/+$/, "");
  const offenders: string[] = [];
  let files = 0;
  for (const file of sources(root, ["__tests__"])) {
    files++;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const hit of line.matchAll(TOKEN_UTILITY)) {
          if (!defined.has(hit[1]!)) {
            offenders.push(`${file.slice(root.length + 1)}:${i + 1} → ${hit[0]}`);
          }
        }
      });
  }
  return { files, offenders };
}

/** What a failing palette text scan tells whoever reads it. */
export const PALETTE_TEXT_ADVICE =
  "uses fixed palette text colours, which cannot clear WCAG AA in both schemes: replace each with a semantic token (text-danger / text-warning / text-success / text-info / text-severe / text-notice / text-series-N)";
