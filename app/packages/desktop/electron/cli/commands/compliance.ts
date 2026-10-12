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
import { CliError, orgFetch, orgFetchDownload, resolveOrg, type CliContext } from "../context";
import type { ComplianceFlags, RangeFlags } from "../args";
import type {
  ComplianceControlRow,
  ComplianceFrameworkSummary,
  ComplianceStatusResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, safe } from "../output";
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

function refuseLocal(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "`compliance` is cloud-only: the evidence is gathered by Infrawrench Cloud from your organization's access reviews, findings and change records, not by this machine. Drop --local, or pass --org <id|name>.",
      2,
    );
  }
}

/** Framework + period off the flags, validated before any request. */
function readSelection(
  flags: ComplianceFlags,
  range: RangeFlags,
): { framework: string; period: { from?: string; to?: string } } {
  const framework = parseComplianceFrameworkFlag(flags.framework);
  if (typeof framework !== "string") throw new CliError(framework.error, 2);
  const period = parseCompliancePeriodFlags(range.from, range.to);
  if ("error" in period) throw new CliError(period.error, 2);
  if (range.last !== undefined) {
    throw new CliError(
      "`compliance` takes an audit period as --from/--to (YYYY-MM-DD), not --last. Omit both for the last 90 days.",
      2,
    );
  }
  return { framework, period };
}

/** `infrawrench compliance [status]`. */
export async function cmdCompliance(
  ctx: CliContext,
  flags: ComplianceFlags,
  range: RangeFlags,
): Promise<void> {
  refuseLocal(ctx);
  const { framework, period } = readSelection(flags, range);
  const org = await resolveOrg(ctx);
  const response = await orgFetch<ComplianceStatusResponse>(
    org.id,
    `/compliance?${complianceQueryString(framework, period)}`,
  );

  if (ctx.flags.output === "json") {
    printJson({
      org: org.id,
      ...response,
      ...(flags.gaps ? { controls: response.controls.filter((r) => r.status === "gaps") } : {}),
    });
    return;
  }

  println(
    `${c.bold(safe(org.displayName))} ${c.dim("·")} ${formatComplianceHeader(response.framework, response.period)}`,
  );
  println(formatComplianceCounts(response.counts));
  println();

  const controls = flags.gaps
    ? response.controls.filter((r) => r.status === "gaps")
    : response.controls;
  if (controls.length === 0) {
    println(
      c.dim(
        flags.gaps
          ? "No gaps: every applicable control has evidence for this period."
          : "This framework has no controls.",
      ),
    );
  } else {
    printTable<ComplianceControlRow>(controls, [
      { header: "control", value: (r) => safe(r.id) },
      { header: "status", value: (r) => formatControlStatus(r.status) },
      { header: "owner", value: (r) => formatControlOwner(r.owner, r.applicable) },
      { header: "title", value: (r) => truncateText(safe(r.title), TITLE_WIDTH) },
    ]);
  }

  if (flags.gaps && controls.length > 0) {
    println();
    for (const row of controls) {
      println(`${c.bold(safe(row.id))} ${c.dim(`· ${safe(row.title)}`)}`);
      for (const reason of row.reasons) println(`  ${c.red("•")} ${safe(reason)}`);
      if (row.notes?.trim()) println(`  ${c.dim(`Notes: ${safe(row.notes)}`)}`);
    }
  }

  println();
  println(`${c.bold("Evidence sources")} ${c.dim(`· ${response.sources.length}`)}`);
  println();
  printTable(response.sources, [
    { header: "source", value: (s) => safe(s.label) },
    { header: "status", value: (s) => formatEvidenceStatus(s.status) },
    {
      header: "summary",
      value: (s) =>
        c.dim(truncateText(safe(s.status === "unavailable" && s.error ? s.error : s.summary), 80)),
    },
  ]);

  println();
  println(
    c.dim(
      `${flags.gaps ? "" : "Only the gaps, with reasons: --gaps. "}Save the evidence pack with \`infrawrench compliance export${
        framework === "soc2" ? "" : ` --framework ${framework}`
      }\`.`,
    ),
  );
}

/** `infrawrench compliance export`: the evidence pack, as a ZIP on disk. */
export async function cmdComplianceExport(
  ctx: CliContext,
  flags: ComplianceFlags,
  range: RangeFlags,
  destination: { out?: string | undefined; file?: string | undefined },
): Promise<void> {
  refuseLocal(ctx);
  const { framework, period } = readSelection(flags, range);
  const org = await resolveOrg(ctx);

  // The period the server will use when a bound is omitted: the same parser
  // the route runs, so the default file name and the JSON say what the pack says.
  const { parseCompliancePeriod } = await import("@infrawrench/client-core");
  const resolved = parseCompliancePeriod(period.from, period.to);
  if ("error" in resolved) throw new CliError(resolved.error, 2);

  const { bytes, contentDisposition } = await orgFetchDownload(
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
    throw new CliError(`The server did not return a ZIP for the ${framework} evidence pack.`);
  }

  const target = await writeDownloadedFile(
    destination.out ??
      destination.file ??
      fileNameFromContentDisposition(contentDisposition) ??
      compliancePackFileName(framework, resolved),
    bytes,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, path: target, bytes: bytes.byteLength, framework, period: resolved });
    return;
  }
  println(
    `${c.green("✓")} ${c.bold(`${framework} evidence pack`)} ${c.dim(
      `· ${resolved.from} to ${resolved.to} → ${target} (${formatBytes(bytes.byteLength)})`,
    )}`,
  );
}

/** `infrawrench compliance frameworks`. */
export async function cmdComplianceFrameworks(ctx: CliContext): Promise<void> {
  refuseLocal(ctx);
  const org = await resolveOrg(ctx);
  const { frameworks } = await orgFetch<{ frameworks: ComplianceFrameworkSummary[] }>(
    org.id,
    "/compliance/frameworks",
  );
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, frameworks });
    return;
  }
  printTable(frameworks, [
    { header: "id", value: (f) => safe(f.id) },
    { header: "framework", value: (f) => c.bold(safe(f.name)) },
    { header: "version", value: (f) => c.dim(safe(f.version)) },
    { header: "controls", value: (f) => String(f.controlCount), align: "right" },
    { header: "description", value: (f) => c.dim(truncateText(safe(f.description), 70)) },
  ]);
  println();
  println(c.dim("Report on one with `infrawrench compliance --framework <id>`."));
}
