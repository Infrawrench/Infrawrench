// `infrawrench config export|plan|apply`: the organization's dashboards,
// workflows, custom graphs, budgets, alert rules and policies as one JSON
// document you can keep in git.
//
// The verb pair is the point: `config export > infrawrench.json`, commit it,
// review the diff like any other change, and `config apply` it back; into the
// same org for disaster recovery, or into a fresh one to seed a staging or
// demo environment. `config plan` is the dry run and writes nothing, so it is
// the thing to run in CI on a pull request.
//
// Cloud-only, like `alerts` and `probes`: the configuration this manages lives
// in the cloud org, and a local desktop workspace has none of it.
//
// The plan schema is checked against `@infrawrench/client-core` by `wire` (the
// same definitions the server and the settings UI use), so a server-side
// change breaks the CLI's build instead of its output. The document itself is
// passed through as the server wrote it: it is the artifact, and this build
// reads only how many entries each section holds.
//
// `--json` shapes:
//   config export --out f  → { org, path, counts }   (no --out: the document itself)
//   config plan            → { org, ...plan }
//   config apply           → { org, ...result }      ({ org, ...plan, applied: false } when up to date)
import { readFileSync, writeFileSync } from "node:fs";
import { Effect, Option, Predicate, Schema, Stdio, Stream } from "effect";
import { Command, Flag } from "effect/cli";
import type {
  OrgConfigApplyMode,
  OrgConfigApplyResult,
  OrgConfigPlan,
  OrgConfigSection,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import { destinationOf, file, out } from "../effect/file-flags";
import * as Print from "../effect/print";
import { confirm } from "../effect/prompt";
import { CliSession } from "../effect/session";
import { knownOr, Unrecognized, wire } from "../effect/wire";
import { c, safe } from "../output";

/** Order the plan renders sections in: the order they are applied. */
const SECTION_LABELS: Partial<Record<string, string>> = {
  budgets: "budgets",
  customGraphs: "custom graphs",
  workflows: "workflows",
  dashboards: "dashboards",
  metricAlerts: "metric alerts",
  probes: "probes",
  slos: "SLOs",
  costCentres: "cost centres",
  tagPolicy: "tag policy",
  alertSettings: "alert settings",
  savingsViews: "savings views",
} satisfies Record<OrgConfigSection, string>;

/** The sections, in {@link SECTION_LABELS}' order. */
const SECTIONS = Object.keys(SECTION_LABELS);

/** A section's label; one this build does not know, by its id. */
const sectionLabel = (section: string): string => SECTION_LABELS[section] ?? section;

const EXPORT_PATH = "/config/export";
const PLAN_PATH = "/config/plan";
const APPLY_PATH = "/config/apply";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

const Action = knownOr(["create", "update", "delete", "unchanged"]);
type Action = typeof Action.Type;

const Plan = Schema.Struct({
  // Only "replace" is called out; anything else reads as a merge.
  mode: Schema.String,
  changes: Schema.Array(
    Schema.Struct({
      section: Schema.String,
      key: Schema.String,
      name: Schema.String,
      action: Action,
      fields: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  unresolved: Schema.Array(
    Schema.Struct({ section: Schema.String, key: Schema.String, detail: Schema.String }),
  ),
  counts: Schema.Struct({
    create: Schema.Finite,
    update: Schema.Finite,
    delete: Schema.Finite,
    unchanged: Schema.Finite,
  }),
});
type Plan = typeof Plan.Type;
const PlanWire = wire<OrgConfigPlan>()(Plan);
const ApplyWire = wire<OrgConfigApplyResult>()(Plan);

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message: "Config as code covers cloud organizations only. Drop --local.",
    });
  }
});

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const sectionsFlag = Flag.String("sections").pipe(
  Flag.withMetavar("a,b"),
  Flag.withDescription("Limit to these sections (budgets, workflows, dashboards, …)"),
  Flag.optional,
);

/* --------------------------------- export --------------------------------- */

/** How many entries each array section of a document holds, by label. */
function summarizeDocument(document: Readonly<Record<string, unknown>>): {
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  for (const section of SECTIONS) {
    const value = document[section];
    if (Array.isArray(value)) counts[sectionLabel(section)] = value.length;
  }
  return { counts };
}

const printDocumentSummary = (document: Readonly<Record<string, unknown>>) => {
  const parts = Object.entries(summarizeDocument(document).counts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`);
  return Print.line(
    parts.length === 0
      ? c.dim("Nothing configured yet. The document is a valid empty starting point.")
      : c.dim(parts.join(" · ")),
  );
};

const exportFlags = {
  out: out.pipe(Flag.withDescription("Write the document here instead of stdout")),
  file: file.pipe(Flag.withDescription("Same as --out")),
  sections: sectionsFlag,
};

const exportDocument = Effect.fn("config.export")(function* (input: {
  readonly out: Option.Option<string>;
  readonly file: Option.Option<string>;
  readonly sections: Option.Option<string>;
}) {
  yield* requireCloud;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const sections = Option.getOrUndefined(input.sections);
  const query = sections ? `?sections=${encodeURIComponent(sections)}` : "";
  const path = `${EXPORT_PATH}${query}`;
  const document = yield* api.json(org.id, path);

  // Trailing newline so the file is a well-formed text file and `git diff`
  // doesn't report "\ No newline at end of file" on every export.
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const target = Option.getOrUndefined(destinationOf(input));
  // No path: the document goes to stdout, so it can be piped or redirected.
  // Deliberately raw even in text mode: this output IS the artifact.
  if (target === undefined) return yield* Print.write(text);

  yield* Effect.try({
    try: () => writeFileSync(target, text, "utf8"),
    catch: (e) => new CliUsageError({ message: `Can't write ${target}: ${errorText(e)}` }),
  });
  const parsed = yield* decodeBody(JsonObject, path)(document);
  if (session.output === "json") {
    return yield* Print.json({ org: org.id, path: target, ...summarizeDocument(parsed) });
  }
  yield* Print.line(`${c.green("✓")} wrote ${c.bold(target)}`);
  yield* printDocumentSummary(parsed);
  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Commit it, then `infrawrench config apply -f <file>` to put it back (or into another org).",
    ),
  );
});

/* ------------------------------- plan / apply ------------------------------ */

/**
 * Drop every section `--sections` doesn't name.
 *
 * Client-side rather than a server parameter because a section the document
 * doesn't carry is already left alone: narrowing here means one committed file
 * can be applied a section at a time, which is how you roll a change out
 * gradually without maintaining several files.
 */
const narrowSections = Effect.fnUntraced(function* (
  document: Readonly<Record<string, unknown>>,
  sections: string | undefined,
) {
  if (!sections) return document;
  const wanted = sections
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((s) => !SECTIONS.includes(s));
  if (unknown.length > 0) {
    return yield* new CliUsageError({
      message: `Unknown section(s): ${unknown.join(", ")}. Valid: ${SECTIONS.join(", ")}.`,
    });
  }
  const narrowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (!SECTIONS.includes(key) || wanted.includes(key)) narrowed[key] = value;
  }
  return narrowed;
});

/** All of standard input, as text: the document piped in (`config export | config apply`). */
const readStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  return yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.mapError((e) => new CliUsageError({ message: `Can't read stdin: ${e.message}` })),
  );
});

/** The document from `--file`, or from stdin when it isn't a terminal. */
const readDocument = Effect.fnUntraced(function* (
  path: string | undefined,
  sections: string | undefined,
) {
  const stdio = yield* Stdio.Stdio;
  let text: string;
  if (path) {
    text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (e) => new CliUsageError({ message: `Can't read ${path}: ${errorText(e)}` }),
    });
  } else if (yield* stdio.stdinIsTerminal) {
    return yield* new CliUsageError({
      message:
        "No document. Pass --file <path> or pipe one on stdin (`infrawrench config export | …`).",
    });
  } else {
    text = yield* readStdin;
  }

  const parsed = yield* Effect.try({
    // JSON.parse's own sentence names where the document stops parsing.
    try: (): unknown => JSON.parse(text),
    catch: (e) => new CliUsageError({ message: `That file isn't valid JSON: ${errorText(e)}` }),
  });
  if (!Predicate.isObject(parsed)) {
    return yield* new CliUsageError({
      message: "Expected a config document object at the top level.",
    });
  }
  return yield* narrowSections(parsed, sections);
});

const ACTION_MARK: Record<Exclude<Action, Unrecognized>, (s: string) => string> = {
  create: c.green,
  update: c.yellow,
  delete: c.red,
  unchanged: c.dim,
};

const ACTION_SIGN: Record<Exclude<Action, Unrecognized>, string> = {
  create: "+",
  update: "~",
  delete: "-",
  unchanged: " ",
};

const printPlan = Effect.fnUntraced(function* (plan: Plan, opts: { applied: boolean }) {
  const interesting = plan.changes.filter((change) => change.action !== "unchanged");
  const heading = opts.applied ? "Applied" : "Plan";
  const modeNote =
    plan.mode === "replace"
      ? c.red(" (replace: anything not in the document is deleted)")
      : c.dim(" (merge)");
  yield* Print.line(`${c.bold(heading)}${modeNote}`);
  yield* Print.line();

  if (interesting.length === 0) {
    yield* Print.line(c.dim("No changes."));
  } else {
    let lastSection: string | null = null;
    for (const change of interesting) {
      if (change.section !== lastSection) {
        if (lastSection !== null) yield* Print.line();
        yield* Print.line(c.bold(safe(sectionLabel(change.section))));
        lastSection = change.section;
      }
      // An action this build does not know is shown by its name, uncoloured.
      const mark =
        change.action instanceof Unrecognized
          ? `${c.dim("?")} ${c.dim(`(${safe(change.action.raw)})`)}`
          : ACTION_MARK[change.action](ACTION_SIGN[change.action]);
      const fields =
        change.action === "update" && change.fields?.length
          ? c.dim(`  (${change.fields.map(safe).join(", ")})`)
          : "";
      yield* Print.line(
        `  ${mark} ${safe(change.name)} ${c.dim(`[${safe(change.key)}]`)}${fields}`,
      );
    }
  }

  yield* Print.line();
  const { create, update, delete: removed, unchanged } = plan.counts;
  const summary = [
    create > 0 ? c.green(`${create} to create`) : null,
    update > 0 ? c.yellow(`${update} to update`) : null,
    removed > 0 ? c.red(`${removed} to delete`) : null,
    unchanged > 0 ? c.dim(`${unchanged} unchanged`) : null,
  ].filter((s): s is string => s !== null);
  yield* Print.line(summary.length > 0 ? summary.join(c.dim(" · ")) : c.dim("nothing to do"));

  if (plan.unresolved.length > 0) {
    yield* Print.line();
    yield* Print.line(c.yellow("Not applied:"));
    for (const item of plan.unresolved) {
      yield* Print.line(`  ${c.dim("!")} ${safe(sectionLabel(item.section))} · ${safe(item.key)}`);
      yield* Print.line(`    ${c.dim(safe(item.detail))}`);
    }
  }
});

const documentFlags = {
  file: file.pipe(Flag.withDescription("The config document (stdin when omitted and piped)")),
  sections: sectionsFlag,
  prune: Flag.Boolean("prune").pipe(
    Flag.withDescription("Also delete what the document doesn't name (mode replace)"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
};

interface DocumentInput {
  readonly file: Option.Option<string>;
  readonly sections: Option.Option<string>;
  readonly prune: boolean;
}

/** The document and mode a plan or an apply sends, as the request body. */
const requestBody = Effect.fnUntraced(function* (input: DocumentInput) {
  const document = yield* readDocument(
    Option.getOrUndefined(input.file),
    Option.getOrUndefined(input.sections),
  );
  const mode: OrgConfigApplyMode = input.prune ? "replace" : "merge";
  return JSON.stringify({ document, mode });
});

const plan = Command.make(
  "plan",
  documentFlags,
  Effect.fn("config.plan")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* requestBody(input);
    const planBody = yield* api.json(org.id, PLAN_PATH, { method: "POST", body });
    if (session.output === "json") {
      const raw = yield* decodeBody(JsonObject, PLAN_PATH)(planBody);
      return yield* Print.json({ org: org.id, ...raw });
    }
    yield* printPlan(yield* decodeBody(PlanWire, PLAN_PATH)(planBody), { applied: false });
  }),
).pipe(
  Command.withAlias("diff"),
  Command.withDescription("What applying a document would change, without changing it"),
);

const apply = Command.make(
  "apply",
  {
    ...documentFlags,
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Apply after printing the plan without asking"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("config.apply")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const stdio = yield* Stdio.Stdio;
    const org = yield* currentOrg;
    const json = session.output === "json";
    const body = yield* requestBody(input);

    // Always plan first, even with -y. The confirmation is worth having, and on
    // an unattended run the printed plan is the record of what the apply did.
    const planBody = yield* api.json(org.id, PLAN_PATH, { method: "POST", body });
    const planned = yield* decodeBody(PlanWire, PLAN_PATH)(planBody);
    const nothingToDo = planned.counts.create + planned.counts.update + planned.counts.delete === 0;

    if (!json) {
      yield* printPlan(planned, { applied: false });
      yield* Print.line();
    }

    if (nothingToDo) {
      if (json) {
        const raw = yield* decodeBody(JsonObject, PLAN_PATH)(planBody);
        return yield* Print.json({ org: org.id, ...raw, applied: false });
      }
      return yield* Print.line(c.dim("Already up to date. Nothing to apply."));
    }

    if (!input.yes) {
      if (!(yield* stdio.stdinIsTerminal)) {
        return yield* new CliUsageError({
          message:
            "Refusing to apply without confirmation on a non-interactive terminal. Re-run with -y once you've reviewed the plan.",
        });
      }
      const deletes = planned.counts.delete;
      const question =
        deletes > 0
          ? `Apply to ${safe(org.displayName)}? ${deletes} entit${deletes === 1 ? "y" : "ies"} will be DELETED`
          : `Apply to ${safe(org.displayName)}?`;
      if (!(yield* confirm(question))) {
        return yield* Print.line(c.dim("Cancelled. Nothing was changed."));
      }
    }

    const resultBody = yield* api.json(org.id, APPLY_PATH, { method: "POST", body });
    if (json) {
      const raw = yield* decodeBody(JsonObject, APPLY_PATH)(resultBody);
      return yield* Print.json({ org: org.id, ...raw });
    }
    yield* printPlan(yield* decodeBody(ApplyWire, APPLY_PATH)(resultBody), { applied: true });
  }),
).pipe(Command.withDescription("Apply a document (plans first, then asks unless -y)"));

export const config = Command.make("config", exportFlags, exportDocument).pipe(
  Command.withDescription(
    "The org's dashboards, workflows, budgets, graphs, alert rules & policies as one JSON document (bare: export)",
  ),
  Command.withSubcommands([
    Command.make("export", exportFlags, exportDocument).pipe(
      Command.withDescription("Print the document, or write it with --out (stdout when no --out)"),
    ),
    plan,
    apply,
  ]),
);
