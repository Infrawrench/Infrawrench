// `infrawrench compliance`: where the org stands against a compliance
// framework (SOC 2, ISO 27001), control by control, from the evidence
// Infrawrench already collects (access reviews, vulnerability findings,
// posture, change records, backups...), plus the evidence pack an auditor asks
// for as a ZIP.
//
// Cloud only. The evidence is gathered and the controls computed server-side
// (`GET /compliance`, the same endpoint the web + desktop Compliance screens
// render); this machine's workspace has none of it, so `--local` refuses
// rather than printing a framework full of gaps.
//
// Types come from `@infrawrench/client-core` type-only; the one runtime
// helper (`parseCompliancePeriod`, so the pack's file name matches the period
// the server defaults to) is reached through a dynamic `import()` (the CLI is
// CJS, client-core ESM).
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type {
  ComplianceFrameworkSummary,
  ComplianceStatusResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import { destination, destinationOf } from "../effect/file-flags";
import * as Print from "../effect/print";
import { from, to } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { decodePaired, spreadBody, wire } from "../effect/wire";
import { c, safe } from "../output";
import { formatBytes } from "../format";
import {
  complianceQueryString,
  compliancePackFileName,
  fileNameFromContentDisposition,
  formatComplianceCounts,
  formatComplianceHeader,
  formatControlOwner,
  formatControlStatus,
  formatEvidenceStatus,
  parseComplianceFrameworkFlag,
  parseCompliancePeriodFlags,
  truncateText,
} from "../compliance-format";
import { writeDownloadedFile } from "../pdf-export";

/** Title column width: wide enough for every paraphrased control title in one line on 120 columns. */
const TITLE_WIDTH = 60;

const Control = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  reasons: Schema.Array(Schema.String),
  applicable: Schema.Boolean,
  owner: Schema.NullOr(Schema.Struct({ displayName: Schema.String })),
  notes: Schema.NullOr(Schema.String),
});
type Control = typeof Control.Type;
const Controls = Schema.Array(Control);

const Status = wire<ComplianceStatusResponse>()(
  Schema.Struct({
    framework: Schema.Struct({ name: Schema.String, version: Schema.String }),
    period: Schema.Struct({ from: Schema.String, to: Schema.String }),
    counts: Schema.Struct({
      evidence: Schema.Finite,
      gaps: Schema.Finite,
      notApplicable: Schema.Finite,
      total: Schema.Finite,
      unowned: Schema.Finite,
    }),
    controls: Schema.Array(Schema.Unknown),
    sources: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        status: Schema.String,
        summary: Schema.String,
        error: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);

const Frameworks = wire<{ frameworks: ComplianceFrameworkSummary[] }>()(
  Schema.Struct({
    frameworks: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        version: Schema.String,
        description: Schema.String,
        controlCount: Schema.Finite,
      }),
    ),
  }),
);
const RawFrameworks = Schema.Struct({ frameworks: Schema.Unknown });

const refuseLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliUsageError({
      message:
        "`compliance` is cloud-only: the evidence is gathered by Infrawrench Cloud from your organization's access reviews, findings and change records, not by this machine. Drop --local, or pass --org <id|name>.",
    });
  }
});

/** `--framework`, `--from`, `--to`, and `--last` only to say it is the wrong flag. */
const selection = {
  framework: Flag.String("framework").pipe(
    Flag.withMetavar("id"),
    Flag.withDescription("soc2 (default) or iso27001; see `compliance frameworks`"),
    Flag.optional,
  ),
  from: from.pipe(Flag.withDescription("Start of the audit period, YYYY-MM-DD")),
  to: to.pipe(Flag.withDescription("End of the audit period, YYYY-MM-DD (default: 90 days)")),
  // Read only to refuse it in a sentence that names the right flags.
  last: Flag.String("last").pipe(Flag.withHidden, Flag.optional),
};

interface SelectionInput {
  readonly framework: Option.Option<string>;
  readonly from: Option.Option<string>;
  readonly to: Option.Option<string>;
  readonly last: Option.Option<string>;
}

/** Framework + period off the flags, validated before any request. */
const readSelection = Effect.fnUntraced(function* (input: SelectionInput) {
  const framework = parseComplianceFrameworkFlag(Option.getOrUndefined(input.framework));
  if (typeof framework !== "string") {
    return yield* new CliUsageError({ message: framework.error });
  }
  const period = parseCompliancePeriodFlags(
    Option.getOrUndefined(input.from),
    Option.getOrUndefined(input.to),
  );
  if ("error" in period) return yield* new CliUsageError({ message: period.error });
  if (Option.isSome(input.last)) {
    return yield* new CliUsageError({
      message:
        "`compliance` takes an audit period as --from/--to (YYYY-MM-DD), not --last. Omit both for the last 90 days.",
    });
  }
  return { framework, period };
});

const gaps = Flag.Boolean("gaps").pipe(
  Flag.withDescription("Only controls without evidence, with the reasons why"),
  Flag.withDefault(false),
  Flag.withoutNegation,
);

const status = Effect.fn("compliance")(function* (
  input: SelectionInput & { readonly gaps: boolean },
) {
  yield* refuseLocal;
  const { framework, period } = yield* readSelection(input);
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const path = `/compliance?${complianceQueryString(framework, period)}`;
  const body = yield* api.json(org.id, path);
  const response = yield* decodeBody(Status, path)(body);
  const controls = (yield* decodePaired(Controls, path)(response.controls)).filter(
    (r) => !input.gaps || r.row.status === "gaps",
  );

  if (session.output === "json") {
    const all = yield* spreadBody({ org: org.id }, body, path);
    return yield* Print.json(input.gaps ? { ...all, controls: controls.map((r) => r.raw) } : all);
  }

  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim("·")} ${formatComplianceHeader(response.framework, response.period)}`,
  );
  yield* Print.line(formatComplianceCounts(response.counts));
  yield* Print.line();

  const rows = controls.map((r) => r.row);
  if (rows.length === 0) {
    yield* Print.line(
      c.dim(
        input.gaps
          ? "No gaps: every applicable control has evidence for this period."
          : "This framework has no controls.",
      ),
    );
  } else {
    yield* Print.table<Control>(rows, [
      { header: "control", value: (r) => safe(r.id) },
      { header: "status", value: (r) => formatControlStatus(r.status) },
      { header: "owner", value: (r) => formatControlOwner(r.owner, r.applicable) },
      { header: "title", value: (r) => truncateText(safe(r.title), TITLE_WIDTH) },
    ]);
  }

  if (input.gaps && rows.length > 0) {
    yield* Print.line();
    for (const row of rows) {
      yield* Print.line(`${c.bold(safe(row.id))} ${c.dim(`· ${safe(row.title)}`)}`);
      for (const reason of row.reasons) yield* Print.line(`  ${c.red("•")} ${safe(reason)}`);
      if (row.notes?.trim()) yield* Print.line(`  ${c.dim(`Notes: ${safe(row.notes)}`)}`);
    }
  }

  yield* Print.line();
  yield* Print.line(`${c.bold("Evidence sources")} ${c.dim(`· ${response.sources.length}`)}`);
  yield* Print.line();
  yield* Print.table(response.sources, [
    { header: "source", value: (s) => safe(s.label) },
    { header: "status", value: (s) => formatEvidenceStatus(s.status) },
    {
      header: "summary",
      value: (s) =>
        c.dim(truncateText(safe(s.status === "unavailable" && s.error ? s.error : s.summary), 80)),
    },
  ]);

  yield* Print.line();
  yield* Print.line(
    c.dim(
      `${input.gaps ? "" : "Only the gaps, with reasons: --gaps. "}Save the evidence pack with \`infrawrench compliance export${
        framework === "soc2" ? "" : ` --framework ${framework}`
      }\`.`,
    ),
  );
});

const statusFlags = { ...selection, gaps };

const exportPack = Command.make(
  "export",
  { ...selection, ...destination },
  Effect.fn("compliance.export")(function* (input) {
    yield* refuseLocal;
    const { framework, period } = yield* readSelection(input);
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;

    // The period the server will use when a bound is omitted: the same parser
    // the route runs, so the default file name and the JSON say what the pack says.
    const { parseCompliancePeriod } = yield* Effect.promise(
      () => import("@infrawrench/client-core"),
    );
    const resolved = parseCompliancePeriod(period.from, period.to);
    if ("error" in resolved) return yield* new CliUsageError({ message: resolved.error });

    const { bytes, contentDisposition } = yield* api.download(
      org.id,
      `/compliance/pack?${complianceQueryString(framework, resolved)}`,
    );
    // Every ZIP starts with a local file header, `PK\x03\x04`. Anything else is
    // an error payload that slipped through with a 200, and writing it as .zip
    // would only surface later as "the archive is damaged".
    if (
      bytes.byteLength < 4 ||
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x4b ||
      bytes[2] !== 0x03 ||
      bytes[3] !== 0x04
    ) {
      return yield* new CliFailure({
        message: `The server did not return a ZIP for the ${framework} evidence pack.`,
      });
    }

    const target = yield* writeDownloadedFile(
      Option.getOrElse(
        destinationOf(input),
        () =>
          fileNameFromContentDisposition(contentDisposition) ??
          compliancePackFileName(framework, resolved),
      ),
      bytes,
    );

    if (session.output === "json") {
      return yield* Print.json({
        org: org.id,
        path: target,
        bytes: bytes.byteLength,
        framework,
        period: resolved,
      });
    }
    yield* Print.line(
      `${c.green("✓")} ${c.bold(`${framework} evidence pack`)} ${c.dim(
        `· ${resolved.from} to ${resolved.to} → ${target} (${formatBytes(bytes.byteLength)})`,
      )}`,
    );
  }),
).pipe(Command.withDescription("Save the auditor's evidence pack as a ZIP (--out names the file)"));

const FRAMEWORKS_PATH = "/compliance/frameworks";

const frameworks = Command.make(
  "frameworks",
  {},
  Effect.fn("compliance.frameworks")(function* () {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, FRAMEWORKS_PATH);
    if (session.output === "json") {
      const raw = yield* decodeBody(RawFrameworks, FRAMEWORKS_PATH)(body);
      return yield* Print.json({ org: org.id, frameworks: raw.frameworks });
    }
    const { frameworks: rows } = yield* decodeBody(Frameworks, FRAMEWORKS_PATH)(body);
    yield* Print.table(rows, [
      { header: "id", value: (f) => safe(f.id) },
      { header: "framework", value: (f) => c.bold(safe(f.name)) },
      { header: "version", value: (f) => c.dim(safe(f.version)) },
      { header: "controls", value: (f) => String(f.controlCount), align: "right" },
      { header: "description", value: (f) => c.dim(truncateText(safe(f.description), 70)) },
    ]);
    yield* Print.line();
    yield* Print.line(c.dim("Report on one with `infrawrench compliance --framework <id>`."));
  }),
).pipe(Command.withDescription("The frameworks Infrawrench can report on"));

export const compliance = Command.make("compliance", statusFlags, status).pipe(
  Command.withDescription(
    "Controls of a compliance framework with evidence, gaps and owners, plus the evidence sources (cloud only)",
  ),
  Command.withSubcommands([
    Command.make("status", statusFlags, status).pipe(
      Command.withDescription("Controls with evidence, gaps and owners (the default)"),
    ),
    exportPack,
    frameworks,
  ]),
);
