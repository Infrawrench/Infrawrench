// Terminal output helpers: ANSI colors, aligned tables, JSON printing.
// Zero-dependency by design — the CLI ships inside the desktop bundle and
// must not grow the electron-builder dependency tree.

let colorEnabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function colorIsEnabled(): boolean {
  return colorEnabled;
}

const ESC = "\u001b";

function wrap(code: number, close: number): (s: string) => string {
  return (s: string) => (colorEnabled ? `${ESC}[${code}m${s}${ESC}[${close}m` : s);
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

/** Palette used to color chart series / plugin names consistently. */
export const SERIES_COLORS = [c.cyan, c.magenta, c.green, c.yellow, c.blue, c.red];

export function seriesColor(index: number): (s: string) => string {
  return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function println(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function printErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

// String width ignoring ANSI escapes (we only emit SGR sequences).
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function padEndVisible(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Right-align (numbers). */
  align?: "left" | "right";
}

export interface TableOptions {
  /** Spaces before every line, for a table nested under a heading. */
  indent?: number;
}

/** Aligned two-space-gutter table with a dimmed header row. */
export function printTable<T>(rows: T[], columns: Column<T>[], options: TableOptions = {}): void {
  const pad = " ".repeat(options.indent ?? 0);
  if (rows.length === 0) {
    println(pad + c.dim("(none)"));
    return;
  }
  const cells = rows.map((row) => columns.map((col) => col.value(row)));
  const widths = columns.map((col, i) =>
    Math.max(visibleWidth(col.header), ...cells.map((r) => visibleWidth(r[i]!))),
  );
  println(
    pad +
      columns
        .map((col, i) => c.dim(padEndVisible(col.header.toUpperCase(), widths[i]!)))
        .join("  "),
  );
  for (const row of cells) {
    println(
      pad +
        row
          .map((cell, i) => {
            if (columns[i]!.align === "right") {
              const gap = widths[i]! - visibleWidth(cell);
              return (gap > 0 ? " ".repeat(gap) : "") + cell;
            }
            return padEndVisible(cell, widths[i]!);
          })
          .join("  "),
    );
  }
}

/** `LABEL   value` aligned key/value block for detail views. */
export function printKeyValues(pairs: Array<[string, string]>): void {
  const width = Math.max(0, ...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    println(`${c.dim(k.padEnd(width))}  ${v}`);
  }
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatNumber(value: number, unit?: string | undefined): string {
  const rounded =
    Math.abs(value) >= 100
      ? value.toFixed(0)
      : Math.abs(value) >= 1
        ? value.toFixed(1)
        : value.toFixed(2);
  return unit ? `${rounded} ${unit}` : rounded;
}
