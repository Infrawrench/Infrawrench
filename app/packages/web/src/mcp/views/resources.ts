/**
 * The view for `list_resources` and `search_resources`: the resources as a
 * table that can be filtered and sorted, refreshed with the same call, and
 * asked about.
 */
import { h, render } from "./draw";
import { resultJson, resultText, startView, type ToolResult } from "./runtime";

interface Resource {
  id: string;
  displayName: string;
  resourceTypeId: string;
  resourceTypeLabel?: string;
  pluginDisplayName?: string;
  accountName?: string;
  fields?: Record<string, unknown>;
}

/** How many of a listing's own fields get a column. */
const FIELD_COLUMNS = 3;

const root = document.body;
let tool = "list_resources";
let args: Record<string, unknown> = {};
let rows: Resource[] = [];
let filter = "";
let sort: { key: string; up: boolean } = { key: "name", up: true };

const view = startView("Infrawrench resources", {
  input(input) {
    args = input;
    // A search names its query; a listing names its type.
    tool = "query" in input || !("resourceTypeId" in input) ? "search_resources" : "list_resources";
  },
  result: show,
});

function isResource(value: unknown): value is Resource {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "displayName" in value &&
    typeof value.displayName === "string"
  );
}

function show(result: ToolResult): void {
  const data = resultJson(result);
  if (result.isError || !Array.isArray(data)) {
    render(root, h("div", { class: "error" }, resultText(result) || "No resources came back."));
    return;
  }
  rows = data.filter(isResource);
  draw();
}

interface Column {
  key: string;
  label: string;
  value(r: Resource): string;
  mono?: boolean;
}

function columns(): Column[] {
  const cols: Column[] = [{ key: "name", label: "Name", value: (r) => r.displayName }];
  if (rows.some((r) => r.resourceTypeLabel)) {
    cols.push({
      key: "type",
      label: "Type",
      value: (r) => r.resourceTypeLabel ?? r.resourceTypeId,
    });
  }
  if (rows.some((r) => r.pluginDisplayName)) {
    cols.push({ key: "provider", label: "Provider", value: (r) => r.pluginDisplayName ?? "" });
  }
  if (rows.some((r) => r.accountName)) {
    cols.push({ key: "account", label: "Account", value: (r) => r.accountName ?? "" });
  }
  // A listing's own fields: the ones most of its rows have a short value for.
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const [key, value] of Object.entries(r.fields ?? {})) {
      if (cell(value) !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const fields = [...counts.entries()]
    .filter(([, n]) => n >= rows.length / 2)
    .slice(0, FIELD_COLUMNS)
    .map(([key]) => key);
  for (const key of fields) {
    cols.push({ key: `field:${key}`, label: key, value: (r) => cell(r.fields?.[key]), mono: true });
  }
  return cols;
}

/** A field's value as one short line, or nothing for one that won't fit in a cell. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.length > 80 ? "" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function draw(): void {
  const cols = columns();
  const needle = filter.toLowerCase();
  const sortCol = cols.find((c) => c.key === sort.key) ?? cols[0];
  const shown = rows
    .filter((r) => !needle || cols.some((c) => c.value(r).toLowerCase().includes(needle)))
    .sort((a, b) => {
      const order = (sortCol?.value(a) ?? "").localeCompare(sortCol?.value(b) ?? "", undefined, {
        numeric: true,
      });
      return sort.up ? order : -order;
    });
  const search = h("input", {
    type: "search",
    placeholder: "Filter",
    value: filter,
    oninput: (e) => {
      if (e.target instanceof HTMLInputElement) filter = e.target.value;
      draw();
      root.querySelector("input")?.focus();
    },
  });
  render(
    root,
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "row" },
        h("h1", {}, `${rows.length} resource${rows.length === 1 ? "" : "s"}`),
        search,
        h("button", { onclick: () => void refresh() }, "Refresh"),
      ),
      shown.length === 0
        ? h("div", { class: "faint" }, rows.length ? "Nothing matches." : "None found.")
        : h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                ...cols.map((c) =>
                  h(
                    "th",
                    {
                      onclick: () => {
                        sort = { key: c.key, up: sort.key === c.key ? !sort.up : true };
                        draw();
                      },
                    },
                    c.label,
                    sort.key === c.key ? (sort.up ? " ↑" : " ↓") : "",
                  ),
                ),
                h("th", {}),
              ),
            ),
            h(
              "tbody",
              {},
              ...shown.map((r) =>
                h(
                  "tr",
                  {},
                  ...cols.map((c) =>
                    h(
                      "td",
                      { class: c.mono ? "mono clip" : "clip", title: c.value(r) },
                      c.value(r),
                    ),
                  ),
                  h(
                    "td",
                    {},
                    h(
                      "button",
                      { onclick: () => view.suggest(`Tell me about ${r.displayName} (${r.id}).`) },
                      "Ask",
                    ),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
  const input = root.querySelector("input");
  if (input && filter) input.setSelectionRange(filter.length, filter.length);
}

async function refresh(): Promise<void> {
  try {
    show(await view.callTool(tool, args));
  } catch (err) {
    render(root, h("div", { class: "error" }, err instanceof Error ? err.message : String(err)));
  }
}
