import {
  COLUMN_FORMATS,
  type ChartSpec,
  type ColumnFormat,
  type TableSpec,
  type ViewColumn,
  type ViewSpec,
} from "./types";

/** Validation of the view specs the model sends with show_table and show_chart. */

const isFormat = (v: unknown): v is ColumnFormat =>
  typeof v === "string" && (COLUMN_FORMATS as readonly string[]).includes(v);

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** A view spec from the model's tool input, or a message saying what is wrong with it. */
export function parseViewSpec(kind: "table" | "chart", input: unknown): ViewSpec | string {
  const o = (input ?? {}) as Record<string, unknown>;
  const title = text(o["title"], 160);
  const sql = text(o["sql"], 20_000);
  if (!title) return "`title` is required.";
  if (!sql) return "`sql` is required.";
  if (kind === "table") {
    const columns: ViewColumn[] = [];
    if (Array.isArray(o["columns"])) {
      for (const c of o["columns"].slice(0, 60)) {
        const name = text((c as Record<string, unknown>)?.["name"], 200);
        if (!name) continue;
        const label = text((c as Record<string, unknown>)["label"], 80);
        const format = (c as Record<string, unknown>)["format"];
        columns.push({
          name,
          ...(label ? { label } : {}),
          ...(isFormat(format) ? { format } : {}),
        });
      }
    }
    const sortBy = text(o["sort_by"], 200);
    const spec: TableSpec = {
      kind: "table",
      title,
      sql,
      ...(columns.length ? { columns } : {}),
      ...(sortBy ? { sort: { column: sortBy, direction: o["sort_desc"] ? "desc" : "asc" } } : {}),
    };
    return spec;
  }
  const chart = o["chart_type"] === "line" ? "line" : o["chart_type"] === "bar" ? "bar" : null;
  if (!chart) return "`chart_type` must be `bar` or `line`.";
  const x = text(o["x"], 200);
  const y = text(o["y"], 200);
  if (!x || !y) return "`x` and `y` name result columns and are required.";
  const series = text(o["series"], 200);
  const format = o["value_format"];
  const spec: ChartSpec = {
    kind: "chart",
    title,
    sql,
    chart,
    x,
    y,
    ...(series ? { series } : {}),
    ...(isFormat(format) ? { format } : {}),
  };
  return spec;
}

/** Problems with a spec against the columns its query actually returned. */
export function checkAgainstResult(spec: ViewSpec, columns: string[]): string | null {
  const has = (c: string) => columns.includes(c);
  const missing = (cs: (string | undefined)[]) => cs.filter((c): c is string => !!c && !has(c));
  const bad =
    spec.kind === "chart"
      ? missing([spec.x, spec.y, spec.series])
      : missing([...(spec.columns ?? []).map((c) => c.name), spec.sort?.column]);
  return bad.length
    ? `The query has no column ${bad.map((c) => `\`${c}\``).join(", ")}; it returned ${columns.map((c) => `\`${c}\``).join(", ")}.`
    : null;
}
