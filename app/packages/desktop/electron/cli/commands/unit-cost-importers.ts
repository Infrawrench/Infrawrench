/**
 * `infrawrench unit-costs sources` and `infrawrench unit-costs importer <key>`:
 * scheduled importers that pull a business metric from a connected account.
 *
 * The importer itself runs in the cloud (the poller claims it on schedule);
 * this command configures it, runs it now, and shows its history. Every
 * provider-specific field (a CloudWatch namespace, a SQL statement) is a
 * plugin-defined param, so the CLI takes them generically as `--set key=value`
 * and lists what each source accepts under `sources`.
 */
import { readFileSync } from "node:fs";

import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  BusinessMetricImporter,
  BusinessMetricImporterInput,
  BusinessMetricImportRun,
  BusinessMetricSourceAccount,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable } from "../output";

/** Flags `importer` reads, gathered by main.ts from the shared parse. */
export interface ImporterFlags {
  file?: string | undefined;
  set: string[];
  from?: string | undefined;
  to?: string | undefined;
}

const HOST_KEYS = new Set(["schedule", "backfillDays", "timezone", "aggregation", "enabled"]);

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Business metric importers run in Infrawrench Cloud, next to the spend they divide.",
    );
  }
}

/** `key=value`, with `@path` reading the value from a file (a SQL statement, usually). */
function parseSet(entry: string): [string, string] {
  const eq = entry.indexOf("=");
  if (eq <= 0) throw new CliError(`--set expects key=value, got "${entry}".`, 2);
  const key = entry.slice(0, eq).trim();
  let value = entry.slice(eq + 1);
  if (value.startsWith("@")) {
    try {
      value = readFileSync(value.slice(1), "utf8");
    } catch (e) {
      throw new CliError(`Couldn't read ${value.slice(1)}: ${(e as Error).message}`, 2);
    }
  }
  return [key, value];
}

function readBody(file: string): unknown {
  const text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`${file} is not valid JSON: ${(e as Error).message}`, 2);
  }
}

function statusLabel(importer: BusinessMetricImporter): string {
  if (!importer.enabled) return c.dim("paused");
  if (importer.lastStatus === "error") return c.red(`failing (${importer.consecutiveFailures}×)`);
  if (!importer.lastRunAt) return c.yellow("first run pending");
  return c.green("ok");
}

/** `infrawrench unit-costs sources`: accounts that can feed a metric, and their fields. */
export async function cmdBusinessMetricSources(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const res = await orgFetch<{ sources: BusinessMetricSourceAccount[] }>(
    org.id,
    "/business-metrics/importer-sources",
  );
  const sources = res.sources ?? [];
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, sources });
    return;
  }
  println(`${c.bold(org.displayName)} ${c.dim("· business metric importer sources")}`);
  println();
  if (sources.length === 0) {
    println(
      c.dim(
        "No connected account can feed a business metric yet. Connect AWS, GCP, Snowflake, " +
          "ClickHouse, PostgreSQL, MySQL or Metronome.",
      ),
    );
    return;
  }
  for (const s of sources) {
    const readOnly =
      s.source.readOnly === "enforced"
        ? "read-only enforced"
        : s.source.readOnly === "validated"
          ? "SELECT/WITH only"
          : "";
    println(
      `${c.bold(s.accountName)} ${c.dim(`(${s.accountId})`)}  ${s.source.label}  ${c.dim(readOnly)}`,
    );
    for (const f of s.source.fields) {
      const extra = [
        f.type,
        f.required ? "required" : "optional",
        f.dependsOn?.length ? `after ${f.dependsOn.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      println(`  ${f.key.padEnd(16)} ${f.label} ${c.dim(`[${extra}]`)}`);
    }
    println();
  }
  println(
    c.dim(
      "Configure one with `infrawrench unit-costs importer <metric> set --account <id> " +
        "--set <field>=<value>` (`--set sql=@query.sql` reads a file).",
    ),
  );
}

function printImporter(importer: BusinessMetricImporter): void {
  const rows: Array<[string, string]> = [
    [
      "source",
      `${importer.sourceLabel ?? "?"} · ${importer.accountName ?? c.yellow("removed account")}`,
    ],
    ["status", statusLabel(importer)],
    ["schedule", `${importer.schedule}, restating ${importer.backfillDays} day(s)`],
    ["timezone", importer.timezone],
    ["aggregation", importer.aggregation],
    ["last run", importer.lastRunAt ?? c.dim("never")],
    ["next run", importer.nextRunAt ?? c.dim("—")],
  ];
  for (const [k, v] of rows) println(`${c.dim(k.padEnd(12))} ${v}`);
  if (importer.lastError) println(`${c.dim("last error".padEnd(12))} ${c.red(importer.lastError)}`);
  for (const [k, v] of Object.entries(importer.params)) {
    const shown = v.includes("\n") ? `\n${v.replace(/^/gm, "    ")}` : v;
    println(`${c.dim(`param ${k}`.padEnd(12))} ${shown}`);
  }
}

function printRuns(runs: BusinessMetricImportRun[]): void {
  if (runs.length === 0) {
    println(c.dim("No runs yet."));
    return;
  }
  printTable(runs, [
    { header: "started", value: (r) => r.startedAt.replace("T", " ").slice(0, 19) },
    { header: "trigger", value: (r) => r.trigger },
    {
      header: "status",
      value: (r) =>
        r.status === "error"
          ? c.red("error")
          : r.status === "running"
            ? c.dim("running")
            : c.green("ok"),
    },
    { header: "window", value: (r) => `${r.from} → ${r.to}` },
    { header: "days", align: "right", value: (r) => String(r.daysWritten) },
    { header: "points", align: "right", value: (r) => String(r.pointsRead) },
    { header: "error", value: (r) => (r.error ? c.red(r.error.slice(0, 80)) : "") },
  ]);
}

/**
 * `infrawrench unit-costs importer <metric> [show|runs|run|set|enable|disable|delete]`.
 */
export async function cmdBusinessMetricImporter(
  ctx: CliContext,
  metric: string,
  action: string | undefined,
  flags: ImporterFlags,
): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const base = `/business-metrics/${encodeURIComponent(metric)}/importer`;
  const json = ctx.flags.output === "json";
  const verb = action ?? "show";

  const current = async () =>
    (await orgFetch<{ importer: BusinessMetricImporter | null }>(org.id, base)).importer;

  switch (verb) {
    case "show": {
      const importer = await current();
      const runs = importer
        ? ((await orgFetch<{ runs: BusinessMetricImportRun[] }>(org.id, `${base}/runs?limit=10`))
            .runs ?? [])
        : [];
      if (json) {
        printJson({ org: org.id, metric, importer, runs });
        return;
      }
      if (!importer) {
        println(
          c.dim(
            `${metric} has no importer; its values are only pushed. See \`infrawrench unit-costs sources\`.`,
          ),
        );
        return;
      }
      println(`${c.bold(metric)} ${c.dim("· importer")}`);
      println();
      printImporter(importer);
      println();
      printRuns(runs);
      return;
    }
    case "runs": {
      const res = await orgFetch<{ runs: BusinessMetricImportRun[] }>(
        org.id,
        `${base}/runs?limit=50`,
      );
      if (json) {
        printJson({ org: org.id, metric, runs: res.runs ?? [] });
        return;
      }
      printRuns(res.runs ?? []);
      return;
    }
    case "run": {
      const body: Record<string, string> = {};
      if (flags.from) body["from"] = flags.from;
      if (flags.to) body["to"] = flags.to;
      const run = await orgFetch<BusinessMetricImportRun>(org.id, `${base}/run`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (json) {
        printJson({ org: org.id, metric, run });
      } else if (run.status === "success") {
        println(
          `${c.green("✓")} ${run.daysWritten} day(s) written, ${run.from} → ${run.to} ${c.dim(`(${run.pointsRead} points, ${run.durationMs ?? 0} ms)`)}`,
        );
        for (const note of run.notes) println(c.dim(`  ${note}`));
      } else {
        println(`${c.red("✗")} ${run.error ?? "the run failed"}`);
      }
      if (run.status === "error") throw new CliError("The import run failed.", 1);
      return;
    }
    case "enable":
    case "disable": {
      const importer = await current();
      if (!importer) throw new CliError(`${metric} has no importer to ${verb}.`);
      const input: BusinessMetricImporterInput = {
        accountId: importer.accountId,
        params: importer.params,
        schedule: importer.schedule,
        backfillDays: importer.backfillDays,
        timezone: importer.timezone,
        aggregation: importer.aggregation,
        enabled: verb === "enable",
      };
      const saved = await orgFetch<BusinessMetricImporter>(org.id, base, {
        method: "PUT",
        body: JSON.stringify(input),
      });
      if (json) printJson({ org: org.id, metric, importer: saved });
      else println(`${metric}: importer ${verb === "enable" ? "enabled" : "paused"}.`);
      return;
    }
    case "set": {
      let input: BusinessMetricImporterInput;
      if (flags.file) {
        input = readBody(flags.file) as BusinessMetricImporterInput;
      } else {
        // Edit in place: start from what is saved, so `--set schedule=weekly`
        // changes one thing rather than resetting the rest to defaults.
        const existing = await current();
        input = existing
          ? {
              accountId: existing.accountId,
              params: { ...existing.params },
              schedule: existing.schedule,
              backfillDays: existing.backfillDays,
              timezone: existing.timezone,
              aggregation: existing.aggregation,
              enabled: existing.enabled,
            }
          : { accountId: "", params: {} };
      }
      if (ctx.flags.account) {
        const sources =
          (
            await orgFetch<{ sources: BusinessMetricSourceAccount[] }>(
              org.id,
              "/business-metrics/importer-sources",
            )
          ).sources ?? [];
        const needle = ctx.flags.account.toLowerCase();
        const match = sources.find(
          (s) => s.accountId === ctx.flags.account || s.accountName.toLowerCase() === needle,
        );
        if (!match) {
          throw new CliError(
            `No importer source called "${ctx.flags.account}". Run \`infrawrench unit-costs sources\`.`,
          );
        }
        if (match.accountId !== input.accountId) input.params = {};
        input.accountId = match.accountId;
      }
      for (const entry of flags.set) {
        const [key, value] = parseSet(entry);
        if (!HOST_KEYS.has(key)) {
          input.params[key] = value;
          continue;
        }
        if (key === "backfillDays") input.backfillDays = Number(value);
        else if (key === "enabled") input.enabled = value === "true" || value === "1";
        else if (key === "schedule")
          input.schedule = value as BusinessMetricImporterInput["schedule"];
        else if (key === "aggregation") {
          input.aggregation = value as BusinessMetricImporterInput["aggregation"];
        } else input.timezone = value;
      }
      if (!input.accountId) {
        throw new CliError("Pick a source account with --account (see `unit-costs sources`).", 2);
      }
      const saved = await orgFetch<BusinessMetricImporter>(org.id, base, {
        method: "PUT",
        body: JSON.stringify(input),
      });
      if (json) {
        printJson({ org: org.id, metric, importer: saved });
        return;
      }
      println(`${c.green("✓")} importer saved for ${metric}. The first run is due now.`);
      println();
      printImporter(saved);
      return;
    }
    case "delete": {
      await orgFetch(org.id, base, { method: "DELETE" });
      if (json) printJson({ org: org.id, metric, deleted: true });
      else println(`${metric}: importer removed. Imported values stay.`);
      return;
    }
    default:
      throw new CliError(
        `Unknown importer action "${verb}". Use show, runs, run, set, enable, disable or delete.`,
        2,
      );
  }
}
