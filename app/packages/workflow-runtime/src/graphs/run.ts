/**
 * Runs a custom-graph script: the same QuickJS isolate as workflows, a
 * different (much narrower) host surface, and a validated render spec as the
 * product. The graph dispatcher below is deliberately separate from the
 * workflow `dispatch` — a graph must never gain workflow powers by accident,
 * so unknown methods fail closed instead of falling through to the wider
 * router.
 *
 * Everything the guest sends is validated HERE, not in the prelude: the
 * prelude is convenience code running inside the sandbox, and a hostile
 * script can bypass it by calling `__host` directly. Every host receives an
 * identical, pre-checked request (the `fetchRequest` precedent).
 */
import type {
  CustomGraphChart,
  CustomGraphControl,
  CustomGraphControlState,
  CustomGraphPoint,
  CustomGraphRenderSpec,
  CustomGraphSeries,
} from "@infrawrench/client-core";
import {
  COST_BINNINGS,
  COST_DIMENSIONS,
  CUSTOM_GRAPH_MAX_REFRESH_SECONDS,
  CUSTOM_GRAPH_MIN_REFRESH_SECONDS,
} from "@infrawrench/client-core";

import { fetchRequest, WorkflowCapabilityError, type WorkflowRunContext } from "../host.js";
import { runIsolate, toError } from "../isolate.js";
import { transpileWorkflow } from "../transpile.js";
import type { RunLogEntry } from "../types.js";
import { GRAPH_EPILOGUE, GRAPH_PRELUDE } from "./prelude.js";
import {
  GRAPH_MAX_CONTROLS,
  GRAPH_MAX_COST_QUERIES,
  GRAPH_MAX_DATA_KEY_LENGTH,
  GRAPH_MAX_DATA_OPS,
  GRAPH_MAX_DATA_VALUE_BYTES,
  GRAPH_MAX_FETCHES,
  GRAPH_MAX_FILTERS,
  GRAPH_MAX_FILTER_VALUES,
  GRAPH_MAX_LOGS,
  GRAPH_MAX_METRIC_QUERIES,
  GRAPH_MAX_METRIC_RANGE_MS,
  GRAPH_MAX_NOTICE,
  GRAPH_MAX_PIE_SLICES,
  GRAPH_MAX_POINTS_PER_SERIES,
  GRAPH_MAX_QUERY_DAYS,
  GRAPH_MAX_RESOURCE_LISTS,
  GRAPH_MAX_SELECT_OPTIONS,
  GRAPH_MAX_SERIES,
  GRAPH_MAX_TABLE_COLUMNS,
  GRAPH_MAX_TABLE_ROWS,
  GRAPH_MAX_TEXT,
  GRAPH_MAX_TOP_N,
  GRAPH_MAX_TOTAL_POINTS,
  GRAPH_RUN_LIMITS,
  type GraphCostQuery,
  type GraphHost,
  type GraphRunResult,
  type RunGraphOptions,
} from "./types.js";

const CONTROL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATA_KEY_RE = /^[A-Za-z0-9_.:-]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Hex or a bare color keyword — never arbitrary CSS. */
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,24})$/;

// Built from the canonical client-core enums so a new dimension or binning
// reaches the sandbox without a second list to remember.
const COST_DIMENSION_SET = new Set<string>(COST_DIMENSIONS);
const COST_BINNING_SET = new Set<string>(COST_BINNINGS);

function fail(message: string): never {
  throw new Error(message);
}

function asText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") fail(`${what} must be a string.`);
  if (value.length > max) fail(`${what} is longer than ${max} characters.`);
  return value;
}

function optionalText(value: unknown, what: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asText(value, what, max);
}

function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/* ------------------------------------------------------------------ *
 * Cost query marshalling.
 * ------------------------------------------------------------------ */

function costQuery(raw: unknown): GraphCostQuery {
  const q = (raw ?? {}) as Record<string, unknown>;

  let from: string;
  let to: string;
  if (q["from"] !== undefined || q["to"] !== undefined) {
    from = String(q["from"] ?? "");
    to = String(q["to"] ?? "");
    if (!isIsoDate(from) || !isIsoDate(to)) {
      fail("graph.costs.query: from/to must be YYYY-MM-DD dates.");
    }
    if (from > to) fail("graph.costs.query: from is after to.");
  } else {
    const days = Number(q["days"] ?? 30);
    if (!Number.isFinite(days) || days < 1) fail("graph.costs.query: days must be >= 1.");
    const span = Math.min(Math.floor(days), GRAPH_MAX_QUERY_DAYS);
    const today = new Date();
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    to = iso(today);
    from = iso(new Date(today.getTime() - (span - 1) * 86_400_000));
  }
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > GRAPH_MAX_QUERY_DAYS) {
    fail(`graph.costs.query: date range is limited to ${GRAPH_MAX_QUERY_DAYS} days.`);
  }

  const binning = String(q["binning"] ?? "daily");
  if (!COST_BINNING_SET.has(binning)) {
    fail(`graph.costs.query: unknown binning ${JSON.stringify(binning)}.`);
  }

  const groupBy = String(q["groupBy"] ?? "none");
  if (groupBy !== "none" && !COST_DIMENSION_SET.has(groupBy)) {
    fail(`graph.costs.query: unknown groupBy ${JSON.stringify(groupBy)}.`);
  }
  const groupByTagKey = optionalText(q["groupByTagKey"], "graph.costs.query: groupByTagKey", 256);
  if (groupBy === "tag" && !groupByTagKey) {
    fail('graph.costs.query: groupBy "tag" needs groupByTagKey.');
  }

  const rawFilters = Array.isArray(q["filters"]) ? q["filters"] : [];
  if (rawFilters.length > GRAPH_MAX_FILTERS) {
    fail(`graph.costs.query: at most ${GRAPH_MAX_FILTERS} filters.`);
  }
  const filters = rawFilters.map((f) => {
    const spec = (f ?? {}) as Record<string, unknown>;
    const dimension = String(spec["dimension"] ?? "");
    if (!COST_DIMENSION_SET.has(dimension)) {
      fail(`graph.costs.query: unknown filter dimension ${JSON.stringify(dimension)}.`);
    }
    const op = spec["op"] === "not_in" ? "not_in" : "in";
    const values = Array.isArray(spec["values"]) ? spec["values"] : [];
    if (values.length === 0 || values.length > GRAPH_MAX_FILTER_VALUES) {
      fail(`graph.costs.query: filters need 1–${GRAPH_MAX_FILTER_VALUES} values.`);
    }
    const tagKey = optionalText(spec["tagKey"], "graph.costs.query: filter tagKey", 256);
    if (dimension === "tag" && !tagKey) fail('graph.costs.query: a "tag" filter needs tagKey.');
    return {
      dimension: dimension as GraphCostQuery["filters"][number]["dimension"],
      op: op as "in" | "not_in",
      values: values.map((v) => asText(v, "graph.costs.query: filter value", 256)),
      ...(tagKey ? { tagKey } : {}),
    };
  });

  const topN = Number(q["topN"] ?? 10);
  return {
    from,
    to,
    binning: binning as GraphCostQuery["binning"],
    groupBy: groupBy as GraphCostQuery["groupBy"],
    ...(groupByTagKey ? { groupByTagKey } : {}),
    filters,
    topN: Number.isFinite(topN) && topN >= 1 ? Math.min(Math.floor(topN), GRAPH_MAX_TOP_N) : 10,
  };
}

/* ------------------------------------------------------------------ *
 * Render-spec validation.
 * ------------------------------------------------------------------ */

function validatePoint(raw: unknown): CustomGraphPoint {
  const p = (raw ?? {}) as Record<string, unknown>;
  const x = p["x"];
  if (typeof x === "number") {
    if (!Number.isFinite(x)) fail("graph.render: point x must be finite.");
  } else if (typeof x === "string") {
    if (x.length > 64) fail("graph.render: point x strings are limited to 64 characters.");
  } else {
    fail("graph.render: point x must be a string or number.");
  }
  const y = p["y"];
  if (y !== null && (typeof y !== "number" || !Number.isFinite(y))) {
    fail("graph.render: point y must be a finite number or null.");
  }
  return { x: x as string | number, y: y as number | null };
}

function validateColor(raw: unknown, what: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const color = String(raw);
  if (!COLOR_RE.test(color)) {
    fail(`${what}: colors must be hex (#rrggbb) or a plain color name.`);
  }
  return color;
}

function validateSeries(raw: unknown): CustomGraphSeries[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail("graph.render: chart.series must be a non-empty array.");
  }
  if (raw.length > GRAPH_MAX_SERIES) {
    fail(`graph.render: at most ${GRAPH_MAX_SERIES} series.`);
  }
  let totalPoints = 0;
  return raw.map((s) => {
    const spec = (s ?? {}) as Record<string, unknown>;
    const key = asText(spec["key"], "graph.render: series key", 120);
    if (!key) fail("graph.render: series key must be non-empty.");
    const points = Array.isArray(spec["points"]) ? spec["points"] : [];
    if (points.length > GRAPH_MAX_POINTS_PER_SERIES) {
      fail(`graph.render: at most ${GRAPH_MAX_POINTS_PER_SERIES} points per series.`);
    }
    totalPoints += points.length;
    if (totalPoints > GRAPH_MAX_TOTAL_POINTS) {
      fail(`graph.render: at most ${GRAPH_MAX_TOTAL_POINTS} points across all series.`);
    }
    const label = optionalText(spec["label"], "graph.render: series label", 120);
    const color = validateColor(spec["color"], "graph.render: series color");
    return {
      key,
      ...(label !== undefined ? { label } : {}),
      ...(color !== undefined ? { color } : {}),
      points: points.map(validatePoint),
    };
  });
}

function validateAxis(
  raw: unknown,
  what: string,
): { label?: string; unit?: string; currency?: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const a = raw as Record<string, unknown>;
  const label = optionalText(a["label"], `${what} label`, 80);
  const unit = optionalText(a["unit"], `${what} unit`, 20);
  const currency = optionalText(a["currency"], `${what} currency`, 8);
  const axis = {
    ...(label !== undefined ? { label } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(currency !== undefined ? { currency } : {}),
  };
  return Object.keys(axis).length > 0 ? axis : undefined;
}

function validateChart(raw: unknown): CustomGraphChart {
  const chart = (raw ?? {}) as Record<string, unknown>;
  const type = String(chart["type"] ?? "");
  switch (type) {
    case "line":
    case "area":
    case "stacked_bar":
    case "multi_bar": {
      const xAxis = validateAxis(chart["xAxis"], "graph.render: xAxis");
      const yAxis = validateAxis(chart["yAxis"], "graph.render: yAxis");
      return {
        type,
        series: validateSeries(chart["series"]),
        ...(xAxis ? { xAxis } : {}),
        ...(yAxis ? { yAxis } : {}),
      };
    }
    case "pie": {
      const raw = Array.isArray(chart["slices"]) ? chart["slices"] : [];
      if (raw.length === 0) fail("graph.render: pie needs at least one slice.");
      if (raw.length > GRAPH_MAX_PIE_SLICES) {
        fail(`graph.render: at most ${GRAPH_MAX_PIE_SLICES} pie slices.`);
      }
      const unit = optionalText(chart["unit"], "graph.render: unit", 20);
      const currency = optionalText(chart["currency"], "graph.render: currency", 8);
      return {
        type,
        slices: raw.map((s) => {
          const spec = (s ?? {}) as Record<string, unknown>;
          const value = Number(spec["value"]);
          if (!Number.isFinite(value)) fail("graph.render: slice value must be finite.");
          const color = validateColor(spec["color"], "graph.render: slice color");
          return {
            label: asText(spec["label"], "graph.render: slice label", 120),
            value,
            ...(color !== undefined ? { color } : {}),
          };
        }),
        ...(unit !== undefined ? { unit } : {}),
        ...(currency !== undefined ? { currency } : {}),
      };
    }
    case "stat": {
      const value = chart["value"];
      if (typeof value !== "number" && typeof value !== "string") {
        fail("graph.render: stat value must be a number or string.");
      }
      if (typeof value === "string" && value.length > 64) {
        fail("graph.render: stat value strings are limited to 64 characters.");
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        fail("graph.render: stat value must be finite.");
      }
      const unit = optionalText(chart["unit"], "graph.render: unit", 20);
      const currency = optionalText(chart["currency"], "graph.render: currency", 8);
      const caption = optionalText(chart["caption"], "graph.render: caption", GRAPH_MAX_TEXT);
      return {
        type,
        value,
        ...(unit !== undefined ? { unit } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(caption !== undefined ? { caption } : {}),
      };
    }
    case "table": {
      const columns = Array.isArray(chart["columns"]) ? chart["columns"] : [];
      if (columns.length === 0 || columns.length > GRAPH_MAX_TABLE_COLUMNS) {
        fail(`graph.render: tables need 1–${GRAPH_MAX_TABLE_COLUMNS} columns.`);
      }
      const rows = Array.isArray(chart["rows"]) ? chart["rows"] : [];
      if (rows.length > GRAPH_MAX_TABLE_ROWS) {
        fail(`graph.render: at most ${GRAPH_MAX_TABLE_ROWS} table rows.`);
      }
      return {
        type,
        columns: columns.map((c) => asText(c, "graph.render: column", 80)),
        rows: rows.map((row) => {
          if (!Array.isArray(row)) fail("graph.render: each table row must be an array.");
          if (row.length > columns.length) {
            fail(
              `graph.render: a row has ${row.length} cells but the table declares ` +
                `${columns.length} columns.`,
            );
          }
          return row.map((cell) => {
            if (cell === null) return null;
            if (typeof cell === "number") {
              return Number.isFinite(cell) ? cell : null;
            }
            return asText(cell, "graph.render: table cell", GRAPH_MAX_TEXT);
          });
        }),
      };
    }
    default:
      fail(
        `graph.render: unknown chart type ${JSON.stringify(type)} ` +
          `(expected line, area, stacked_bar, multi_bar, pie, stat, or table).`,
      );
  }
}

function validateControls(raw: unknown): CustomGraphControl[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > GRAPH_MAX_CONTROLS) {
    fail(`graph.controls: at most ${GRAPH_MAX_CONTROLS} controls.`);
  }
  const seen = new Set<string>();
  return list.map((c) => {
    const spec = (c ?? {}) as Record<string, unknown>;
    const id = String(spec["id"] ?? "");
    if (!CONTROL_ID_RE.test(id)) {
      fail(`graph.controls: control id ${JSON.stringify(id)} must match [A-Za-z0-9_-]{1,64}.`);
    }
    if (seen.has(id)) fail(`graph.controls: duplicate control id ${JSON.stringify(id)}.`);
    seen.add(id);
    const label = asText(spec["label"] ?? id, "graph.controls: label", 120);
    switch (spec["kind"]) {
      case "select": {
        const raw = Array.isArray(spec["options"]) ? spec["options"] : [];
        if (raw.length === 0 || raw.length > GRAPH_MAX_SELECT_OPTIONS) {
          fail(`graph.controls: selects need 1–${GRAPH_MAX_SELECT_OPTIONS} options.`);
        }
        const options = raw.map((o) => {
          const opt = (o ?? {}) as Record<string, unknown>;
          return {
            value: asText(opt["value"], "graph.controls: option value", 120),
            label: asText(opt["label"] ?? opt["value"], "graph.controls: option label", 120),
          };
        });
        const value = String(spec["value"] ?? "");
        return {
          kind: "select",
          id,
          label,
          options,
          value: options.some((o) => o.value === value) ? value : options[0]!.value,
        };
      }
      case "checkbox":
        return { kind: "checkbox", id, label, value: spec["value"] === true };
      case "button":
        return {
          kind: "button",
          id,
          label,
          ...(spec["danger"] === true ? { danger: true } : {}),
        };
      case "text": {
        const placeholder = optionalText(spec["placeholder"], "graph.controls: placeholder", 120);
        return {
          kind: "text",
          id,
          label,
          value: asText(spec["value"] ?? "", "graph.controls: text value", 500),
          ...(placeholder !== undefined ? { placeholder } : {}),
        };
      }
      case "number": {
        const value = Number(spec["value"] ?? 0);
        const bound = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined;
        const min = bound(spec["min"]);
        const max = bound(spec["max"]);
        const step = bound(spec["step"]);
        return {
          kind: "number",
          id,
          label,
          value: Number.isFinite(value) ? value : 0,
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
          ...(step !== undefined ? { step } : {}),
        };
      }
      default:
        fail(`graph.controls: unknown control kind ${JSON.stringify(spec["kind"])}.`);
    }
  });
}

function validateRenderSpec(rawSpec: unknown, rawControls: unknown): CustomGraphRenderSpec {
  const spec = (rawSpec ?? {}) as Record<string, unknown>;
  const title = optionalText(spec["title"], "graph.render: title", GRAPH_MAX_TEXT);
  const notice = optionalText(spec["notice"], "graph.render: notice", GRAPH_MAX_NOTICE);
  let refreshSeconds: number | undefined;
  if (spec["refreshSeconds"] !== undefined && spec["refreshSeconds"] !== null) {
    const n = Number(spec["refreshSeconds"]);
    if (!Number.isFinite(n) || n <= 0) fail("graph.render: refreshSeconds must be positive.");
    refreshSeconds = Math.min(
      Math.max(Math.floor(n), CUSTOM_GRAPH_MIN_REFRESH_SECONDS),
      CUSTOM_GRAPH_MAX_REFRESH_SECONDS,
    );
  }
  return {
    version: 1,
    ...(title !== undefined ? { title } : {}),
    chart: validateChart(spec["chart"]),
    controls: validateControls(rawControls),
    ...(refreshSeconds !== undefined ? { refreshSeconds } : {}),
    ...(notice !== undefined ? { notice } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The graph dispatcher and runner.
 * ------------------------------------------------------------------ */

/** Count a capability's calls against its per-run budget. */
function budgeted(max: number, what: string): () => void {
  let used = 0;
  return () => {
    used += 1;
    if (used > max) fail(`A graph run may make at most ${max} ${what}.`);
  };
}

export async function runGraph(opts: RunGraphOptions): Promise<GraphRunResult> {
  const startedAt = Date.now();
  const logs: RunLogEntry[] = [];
  let spec: CustomGraphRenderSpec | undefined;

  const ctx: WorkflowRunContext = {
    interactive: false,
    log: (entry) => {
      if (logs.length >= GRAPH_MAX_LOGS) return;
      logs.push(entry);
      opts.onLog?.(entry);
    },
    setOutput: () => {},
  };

  const countCosts = budgeted(GRAPH_MAX_COST_QUERIES, "cost queries");
  const countMetrics = budgeted(GRAPH_MAX_METRIC_QUERIES, "metric queries");
  const countLists = budgeted(GRAPH_MAX_RESOURCE_LISTS, "resource listings");
  const countData = budgeted(GRAPH_MAX_DATA_OPS, "data-store operations");
  const countFetches = budgeted(GRAPH_MAX_FETCHES, "fetch calls");

  const host = opts.host;
  const dispatcher = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case "log":
        ctx.log({
          at: Date.now(),
          level: args["level"] === "warn" || args["level"] === "error" ? args["level"] : "info",
          message: String(args["message"] ?? "").slice(0, 4000),
        });
        return null;

      case "graph.render":
        spec = validateRenderSpec(args["spec"], args["controls"]);
        return null;

      case "graph.costs.query": {
        countCosts();
        return host.queryCosts(costQuery(args["query"]));
      }

      case "graph.resources.list": {
        countLists();
        const f = (args["filter"] ?? {}) as Record<string, unknown>;
        return host.listResources({
          pluginId: optionalText(f["pluginId"], "graph.resources.list: pluginId", 100),
          resourceTypeId: optionalText(f["resourceTypeId"], "graph.resources.list: typeId", 100),
          accountId: optionalText(f["accountId"], "graph.resources.list: accountId", 100),
          search: optionalText(f["search"], "graph.resources.list: search", 200),
        });
      }

      case "graph.metrics": {
        countMetrics();
        const resourceId = asText(args["resourceId"], "graph.metrics: resourceId", 200);
        if (!resourceId) fail("graph.metrics: resourceId is required.");
        const now = Date.now();
        let startMs = Number(args["startMs"]);
        let endMs = Number(args["endMs"]);
        if (!Number.isFinite(endMs)) endMs = now;
        if (!Number.isFinite(startMs)) {
          const hours = Number(args["hours"] ?? 24);
          startMs = endMs - (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;
        }
        if (startMs >= endMs) fail("graph.metrics: start must be before end.");
        if (endMs - startMs > GRAPH_MAX_METRIC_RANGE_MS) {
          fail("graph.metrics: range is limited to 90 days.");
        }
        return host.metricSeries(resourceId, { startMs, endMs });
      }

      case "graph.data.get": {
        countData();
        // Returned bare, not enveloped: JSON.stringify(null) crosses the RPC
        // bridge as "null" just fine, and the guest expects the stored value.
        const value = await host.dataGet(dataKey(args));
        return value === undefined ? null : value;
      }
      case "graph.data.set": {
        countData();
        const valueJson = String(args["valueJson"] ?? "null");
        if (valueJson.length > GRAPH_MAX_DATA_VALUE_BYTES) {
          fail(`graph.data.set: values are limited to ${GRAPH_MAX_DATA_VALUE_BYTES} bytes.`);
        }
        await host.dataSet(dataKey(args), JSON.parse(valueJson));
        return null;
      }
      case "graph.data.delete": {
        countData();
        await host.dataDelete(dataKey(args));
        return null;
      }
      case "graph.data.list": {
        countData();
        return host.dataList();
      }

      case "fetch": {
        countFetches();
        if (!host.fetch) {
          throw new WorkflowCapabilityError("This graph host does not support fetch().");
        }
        return host.fetch(fetchRequest(args["request"]));
      }

      default:
        fail(`"${method}" is not available in a custom graph.`);
    }
  };

  let userJs: string;
  try {
    userJs = (await transpileWorkflow(opts.source)).code;
  } catch (err) {
    const finishedAt = Date.now();
    return {
      status: "failure",
      error: toError(err, "Failed to compile graph") ?? { message: "Failed to compile graph" },
      logs,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    };
  }

  const outcome = await runIsolate({
    program: buildProgram(userJs),
    dispatcher,
    ctx,
    env: {
      accountsTree: "[]",
      metrics: "{}",
      event: JSON.stringify({
        // A button press is always an interaction, whatever the caller said.
        kind: opts.button
          ? "interaction"
          : opts.trigger === "refresh" || opts.trigger === "interaction"
            ? opts.trigger
            : "manual",
        ...(opts.button ? { button: opts.button } : {}),
        controls: sanitizeControlState(opts.controls),
      }),
    },
    limits: { ...GRAPH_RUN_LIMITS, ...opts.limits },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const finishedAt = Date.now();
  const base = { logs, startedAt, finishedAt, durationMs: finishedAt - startedAt };
  if (outcome.error) return { status: "failure", error: outcome.error, ...base };
  if (!spec) {
    return {
      status: "failure",
      error: { message: "The graph never called graph.render(...) — nothing to display." },
      ...base,
    };
  }
  return { status: "success", spec, ...base };
}

function dataKey(args: Record<string, unknown>): string {
  const key = String(args["key"] ?? "");
  if (!key || key.length > GRAPH_MAX_DATA_KEY_LENGTH || !DATA_KEY_RE.test(key)) {
    fail(`graph.data: keys must be 1–${GRAPH_MAX_DATA_KEY_LENGTH} characters of [A-Za-z0-9_.:-].`);
  }
  return key;
}

/**
 * The control state clients send is untrusted input too: keep only primitive
 * values under sane sizes so a hostile client can't smuggle payloads into the
 * guest via `__event`.
 */
function sanitizeControlState(state: CustomGraphControlState | undefined): CustomGraphControlState {
  const out: CustomGraphControlState = {};
  if (!state) return out;
  for (const [key, value] of Object.entries(state).slice(0, 40)) {
    if (!CONTROL_ID_RE.test(key)) continue;
    if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && value.length <= 500) out[key] = value;
  }
  return out;
}

function buildProgram(userJs: string): string {
  return [
    `export {};`,
    `const __host = env.__host;`,
    `const __event = env.__event;`,
    GRAPH_PRELUDE,
    `const __task = (async () => {`,
    `  try {`,
    userJs,
    GRAPH_EPILOGUE,
    `  } catch (e) {`,
    `    await __host("__error", JSON.stringify({ message: (e && e.message) ? String(e.message) : String(e), stack: (e && e.stack) ? String(e.stack) : undefined }));`,
    `  }`,
    `})();`,
    `await __task;`,
  ].join("\n");
}
