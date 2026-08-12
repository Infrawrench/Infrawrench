// `infrawrench config export|plan|apply` — the organization's dashboards,
// workflows, custom graphs, budgets, alert rules and policies as one JSON
// document you can keep in git.
//
// The verb pair is the point: `config export > infrawrench.json`, commit it,
// review the diff like any other change, and `config apply` it back — into the
// same org for disaster recovery, or into a fresh one to seed a staging or
// demo environment. `config plan` is the dry run and writes nothing, so it is
// the thing to run in CI on a pull request.
//
// Cloud-only, like `alerts` and `probes`: the configuration this manages lives
// in the cloud org, and a local desktop workspace has none of it.
//
// The document and plan shapes come from `@infrawrench/client-core` — the same
// definitions the server and the settings UI use — so a server-side change
// breaks the CLI's build instead of its output. The imports are type-only, so
// the CLI still ships zero new runtime dependencies.
import { readFileSync, writeFileSync } from "node:fs";
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { ConfigFlags } from "../args";
import type {
  OrgConfigApplyMode,
  OrgConfigApplyResult,
  OrgConfigChange,
  OrgConfigDocument,
  OrgConfigPlan,
  OrgConfigSection,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println } from "../output";
import { confirm } from "../prompt";

/** Order the plan renders sections in — the order they are applied. */
const SECTION_LABELS: Record<string, string> = {
  budgets: "budgets",
  customGraphs: "custom graphs",
  workflows: "workflows",
  dashboards: "dashboards",
  metricAlerts: "metric alerts",
  probes: "probes",
  costCentres: "cost centres",
  tagPolicy: "tag policy",
  alertSettings: "alert settings",
};

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Config as code covers a cloud organization's dashboards, workflows, budgets and policies — a local workspace has none of them. Drop --local.",
    );
  }
}

export async function cmdConfig(
  ctx: CliContext,
  subcommand: string | undefined,
  flags: ConfigFlags,
): Promise<void> {
  switch (subcommand) {
    case undefined:
    case "export":
      return cmdConfigExport(ctx, flags);
    case "plan":
    case "diff":
      return cmdConfigPlan(ctx, flags);
    case "apply":
      return cmdConfigApply(ctx, flags);
    default:
      throw new CliError(`Unknown config subcommand "${subcommand}". Try: export, plan, apply.`, 2);
  }
}

/* --------------------------------- export --------------------------------- */

async function cmdConfigExport(ctx: CliContext, flags: ConfigFlags): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const query = flags.sections ? `?sections=${encodeURIComponent(flags.sections)}` : "";
  const document = await orgFetch<OrgConfigDocument>(org.id, `/config/export${query}`);

  // Trailing newline so the file is a well-formed text file and `git diff`
  // doesn't report "\ No newline at end of file" on every export.
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const path = flags.out ?? flags.file;
  if (path) {
    try {
      writeFileSync(path, text, "utf8");
    } catch (e) {
      throw new CliError(`Can't write ${path}: ${e instanceof Error ? e.message : String(e)}`, 2);
    }
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, path, ...summarizeDocument(document) });
      return;
    }
    println(`${c.green("✓")} wrote ${c.bold(path)}`);
    printDocumentSummary(document);
    println();
    println(
      c.dim(
        "Commit it, then `infrawrench config apply -f <file>` to put it back (or into another org).",
      ),
    );
    return;
  }

  // No path: the document goes to stdout, so it can be piped or redirected.
  // Deliberately raw even in text mode — this output IS the artifact.
  process.stdout.write(text);
}

interface DocumentSummary {
  counts: Record<string, number>;
}

function summarizeDocument(document: OrgConfigDocument): DocumentSummary {
  const counts: Record<string, number> = {};
  for (const [section, label] of Object.entries(SECTION_LABELS)) {
    const value = (document as unknown as Record<string, unknown>)[section];
    if (Array.isArray(value)) counts[label] = value.length;
  }
  return { counts };
}

function printDocumentSummary(document: OrgConfigDocument): void {
  const { counts } = summarizeDocument(document);
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`);
  if (parts.length === 0) {
    println(c.dim("Nothing configured yet — the document is a valid empty starting point."));
    return;
  }
  println(c.dim(parts.join(" · ")));
}

/* ------------------------------- plan / apply ------------------------------ */

async function cmdConfigPlan(ctx: CliContext, flags: ConfigFlags): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const document = readDocument(flags);
  const mode: OrgConfigApplyMode = flags.prune ? "replace" : "merge";

  const plan = await orgFetch<OrgConfigPlan>(org.id, "/config/plan", {
    method: "POST",
    body: JSON.stringify({ document, mode }),
  });

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...plan });
    return;
  }
  printPlan(plan, { applied: false });
}

async function cmdConfigApply(ctx: CliContext, flags: ConfigFlags): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const document = readDocument(flags);
  const mode: OrgConfigApplyMode = flags.prune ? "replace" : "merge";

  // Always plan first, even with -y. The confirmation is worth having, and on
  // an unattended run the printed plan is the record of what the apply did.
  const plan = await orgFetch<OrgConfigPlan>(org.id, "/config/plan", {
    method: "POST",
    body: JSON.stringify({ document, mode }),
  });
  const nothingToDo = plan.counts.create + plan.counts.update + plan.counts.delete === 0;

  if (ctx.flags.output !== "json") {
    printPlan(plan, { applied: false });
    println();
  }

  if (nothingToDo) {
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, ...plan, applied: false });
      return;
    }
    println(c.dim("Already up to date — nothing to apply."));
    return;
  }

  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      throw new CliError(
        "Refusing to apply without confirmation on a non-interactive terminal. Re-run with -y once you've reviewed the plan.",
        2,
      );
    }
    const verb =
      plan.counts.delete > 0
        ? `Apply to ${org.displayName}? ${plan.counts.delete} entit${plan.counts.delete === 1 ? "y" : "ies"} will be DELETED`
        : `Apply to ${org.displayName}?`;
    if (!(await confirm(verb))) {
      println(c.dim("Cancelled — nothing was changed."));
      return;
    }
  }

  const result = await orgFetch<OrgConfigApplyResult>(org.id, "/config/apply", {
    method: "POST",
    body: JSON.stringify({ document, mode }),
  });

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...result });
    return;
  }
  printPlan(result, { applied: true });
}

/** The document from `--file`, or from stdin when it isn't a terminal. */
function readDocument(flags: ConfigFlags): unknown {
  let text: string;
  if (flags.file) {
    try {
      text = readFileSync(flags.file, "utf8");
    } catch (e) {
      throw new CliError(
        `Can't read ${flags.file}: ${e instanceof Error ? e.message : String(e)}`,
        2,
      );
    }
  } else if (process.stdin.isTTY) {
    throw new CliError(
      "No document — pass --file <path> or pipe one on stdin (`infrawrench config export | …`).",
      2,
    );
  } else {
    text = readFileSyncStdin();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CliError(
      `That file isn't valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      2,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Expected a config document object at the top level.", 2);
  }
  return narrowSections(parsed as Record<string, unknown>, flags.sections);
}

/** Read all of stdin synchronously — fd 0 to EOF. */
function readFileSyncStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch (e) {
    throw new CliError(`Can't read stdin: ${e instanceof Error ? e.message : String(e)}`, 2);
  }
}

/**
 * Drop every section `--sections` doesn't name.
 *
 * Client-side rather than a server parameter because a section the document
 * doesn't carry is already left alone — narrowing here means one committed file
 * can be applied a section at a time, which is how you roll a change out
 * gradually without maintaining several files.
 */
function narrowSections(
  document: Record<string, unknown>,
  sections: string | undefined,
): Record<string, unknown> {
  if (!sections) return document;
  const wanted = sections
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((s) => !(s in SECTION_LABELS));
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown section(s): ${unknown.join(", ")}. Valid: ${Object.keys(SECTION_LABELS).join(", ")}.`,
      2,
    );
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (!(key in SECTION_LABELS) || wanted.includes(key)) out[key] = value;
  }
  return out;
}

/* -------------------------------- rendering -------------------------------- */

const ACTION_MARK: Record<OrgConfigChange["action"], (s: string) => string> = {
  create: c.green,
  update: c.yellow,
  delete: c.red,
  unchanged: c.dim,
};

const ACTION_SIGN: Record<OrgConfigChange["action"], string> = {
  create: "+",
  update: "~",
  delete: "-",
  unchanged: " ",
};

function printPlan(plan: OrgConfigPlan, opts: { applied: boolean }): void {
  const interesting = plan.changes.filter((change) => change.action !== "unchanged");
  const heading = opts.applied ? "Applied" : "Plan";
  const modeNote =
    plan.mode === "replace"
      ? c.red(" (replace — anything not in the document is deleted)")
      : c.dim(" (merge)");
  println(`${c.bold(heading)}${modeNote}`);
  println();

  if (interesting.length === 0) {
    println(c.dim("No changes."));
  } else {
    let lastSection: OrgConfigSection | null = null;
    for (const change of interesting) {
      if (change.section !== lastSection) {
        if (lastSection !== null) println();
        println(c.bold(SECTION_LABELS[change.section] ?? change.section));
        lastSection = change.section;
      }
      const paint = ACTION_MARK[change.action];
      const fields =
        change.action === "update" && change.fields?.length
          ? c.dim(`  (${change.fields.join(", ")})`)
          : "";
      println(
        `  ${paint(ACTION_SIGN[change.action])} ${change.name} ${c.dim(`[${change.key}]`)}${fields}`,
      );
    }
  }

  println();
  const { create, update, delete: removed, unchanged } = plan.counts;
  const summary = [
    create > 0 ? c.green(`${create} to create`) : null,
    update > 0 ? c.yellow(`${update} to update`) : null,
    removed > 0 ? c.red(`${removed} to delete`) : null,
    unchanged > 0 ? c.dim(`${unchanged} unchanged`) : null,
  ].filter((s): s is string => s !== null);
  println(summary.length > 0 ? summary.join(c.dim(" · ")) : c.dim("nothing to do"));

  if (plan.unresolved.length > 0) {
    println();
    println(c.yellow("Not applied:"));
    for (const item of plan.unresolved) {
      println(`  ${c.dim("!")} ${SECTION_LABELS[item.section] ?? item.section} · ${item.key}`);
      println(`    ${c.dim(item.detail)}`);
    }
  }
}
