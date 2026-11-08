// `infrawrench export`: write a file in someone else's format.
//
// `--format terraform` (the default) ejects an account's inventory as
// Terraform HCL. Mapping runs from the same stored/enumerated state the
// `resources` command shows, through each plugin's declared terraformExport
// capability and the shared plugin-base HCL serializer: identical output to
// the web app's "Export to Terraform" action.
//
// `--format focus`, `--async` and `export jobs` are cost data, not
// inventory: they share the verb because each writes a file in someone else's
// format, but take the `costs` flags rather than `--account`. They live in
// `exports.ts`, beside the scheduled exports.
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { getPlugin } from "../../../src/plugins/loader";
import { cloudResources, listLocalResources, type ResourceRow } from "../context";
import { CliFailure, CliUsageError } from "../effect/errors";
import { destination, destinationOf } from "../effect/file-flags";
import * as Print from "../effect/print";
import { costScope, dateRange } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { c, safe } from "../output";
import { exportFocus, exportJob, exportJobFlags, exportJobs } from "./exports";
import { resolveScopedAccount } from "./listing";

function toResourceInstance(row: ResourceRow): ResourceInstance {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(row.fields)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields[key] = value;
    }
  }
  const outputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.outputs)) {
    if (typeof value === "string") outputs[key] = value;
  }
  return {
    id: row.id,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    accountId: row.accountId,
    displayName: row.displayName,
    fields,
    resolvedOutputs: outputs,
    secretStates: [],
    ...(row.externalId ? { externalId: row.externalId } : {}),
    ...(row.parentResourceId ? { parentResourceId: row.parentResourceId } : {}),
    createdAt: "",
    updatedAt: "",
  };
}

/** `infrawrench export [--format terraform]`: an account's inventory as HCL. */
const exportTerraform = Effect.fnUntraced(function* (format: Option.Option<string>) {
  const session = yield* CliSession;
  const chosen = Option.getOrElse(format, () => "terraform");
  if (chosen !== "terraform") {
    return yield* new CliUsageError({
      message: `Unknown export format "${chosen}". Use "terraform" (an account's inventory as HCL) or "focus" (cost rows as a FOCUS CSV).`,
    });
  }
  const { orgId, account } = yield* resolveScopedAccount();

  const loaded = yield* Effect.promise(() => getPlugin(account.pluginId));
  if (!loaded) {
    return yield* new CliFailure({ message: `Plugin "${account.pluginId}" is not available.` });
  }
  const capability = loaded.plugin.terraformExport;
  if (!capability) {
    return yield* new CliFailure({
      message: `The ${account.pluginId} plugin has no Terraform mapping yet. Nothing to export.`,
    });
  }

  let rows: ResourceRow[];
  if (orgId) {
    rows = yield* cloudResources(orgId, account.id);
  } else {
    const listing = yield* Effect.promise(() => listLocalResources(account, {}));
    // Types the provider refused would silently vanish from the export:
    // report them on stderr so `--json`/redirected stdout stay clean.
    for (const e of listing.errors) {
      yield* Print.errLine(c.yellow(`${safe(e.typeId)}: ${safe(e.message)}`));
    }
    rows = listing.rows;
  }

  // Top-level resources lead the file; children follow.
  const ordered = [...rows].sort(
    (a, b) =>
      (a.parentResourceId ? 1 : 0) - (b.parentResourceId ? 1 : 0) || a.id.localeCompare(b.id),
  );
  const outcome = exportResourcesToTerraform(ordered.map(toResourceInstance), (pluginId) =>
    pluginId === account.pluginId ? capability : undefined,
  );

  if (session.output === "json") return yield* Print.json(outcome);

  // Unsupported resources go to stderr so `> main.tf` captures pure HCL.
  if (outcome.unsupported.length > 0) {
    yield* Print.errLine(
      c.yellow(
        `${outcome.unsupported.length} resource(s) have no Terraform mapping yet and were left out:`,
      ),
    );
    for (const u of outcome.unsupported) {
      yield* Print.errLine(
        c.yellow(`  - ${safe(u.displayName)} (${safe(u.resourceTypeId)}): ${safe(u.reason)}`),
      );
    }
  }
  if (!outcome.hcl) {
    return yield* Print.errLine(
      c.yellow("Nothing to export. No resource in this account has a Terraform mapping."),
    );
  }
  yield* Print.errLine(
    c.dim(
      `${outcome.exported.length} resource(s) exported. Secrets are var.* inputs; ` +
        "see the `terraform import` hints to adopt live resources into state.",
    ),
  );
  yield* Print.line(outcome.hcl.trimEnd());
});

const wait = exportJobFlags.wait;

/** `infrawrench export jobs [<id> [cancel]]`: your recent background export jobs. */
const jobs = Command.make(
  "jobs",
  {
    id: Argument.String("id").pipe(
      Argument.withDescription("One job, by id or its first characters"),
      Argument.optional,
    ),
    action: Argument.String("cancel").pipe(
      Argument.withDescription("cancel: stop the job"),
      Argument.optional,
    ),
    wait: wait.pipe(Flag.withDescription("Poll until the file is ready, then write it")),
    ...destination,
  },
  Effect.fn("export.jobs")(function* (input) {
    yield* exportJobs(input.id, input.action, {
      wait: input.wait,
      out: destinationOf(input),
    });
  }),
).pipe(
  Command.withDescription(
    "Your recent export jobs; one job's status (--wait downloads it); cancel one",
  ),
);

export const exportCommand = Command.make(
  "export",
  {
    report: Argument.String("report").pipe(
      Argument.withDescription(
        "--format focus / --async: a saved report (name or id) whose range and filters to start from",
      ),
      Argument.variadic(),
    ),
    format: Flag.String("format").pipe(
      Flag.withMetavar("terraform|focus|csv|ndjson"),
      Flag.withDescription(
        "terraform (default: an account's inventory as HCL), focus (cost rows as a FOCUS CSV); csv, ndjson or focus with --async",
      ),
      Flag.optional,
    ),
    ...exportJobFlags,
    ...destination,
    ...dateRange,
    ...costScope,
  },
  Effect.fn("export")(function* (input) {
    const report = input.report.join(" ");
    const out = destinationOf(input);
    // Background export jobs: `--async` queues one instead of streaming the
    // file in this request.
    if (input.async) {
      return yield* exportJob(input, report, {
        format: input.format,
        focusVersion: input.focusVersion,
        wait: input.wait,
        out,
        dimensions: input.dimensions,
      });
    }
    // `--format focus` is cost data, not inventory: it shares the verb
    // because both write a file in someone else's format, but takes the
    // `costs` flags rather than `--account`.
    if (Option.getOrUndefined(input.format) === "focus") {
      return yield* exportFocus(input, report, out, input.focusVersion);
    }
    yield* exportTerraform(input.format);
  }),
).pipe(
  Command.withDescription(
    "Eject an account's inventory as Terraform HCL, or cost rows as FOCUS / a background export job",
  ),
  Command.withSubcommands([jobs]),
);
