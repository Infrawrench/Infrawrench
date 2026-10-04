// Shared by `reports --format pdf` and `dashboards --format pdf`: download the
// server-rendered PDF and write it to disk. The rendering is the server's job
// (the same document the web download and the scheduled delivery attach), so
// the CLI only fetches bytes and picks a file name.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ParsedCli } from "./args";
import { CliError, orgFetchBytes, type CliContext } from "./context";
import { formatBytes, pdfFileName } from "./format";
import { c, printJson, println } from "./output";

/** `--format` / `--out` / `--file` as the PDF-capable commands read them. */
export interface PdfExportFlags {
  format?: string | undefined;
  out?: string | undefined;
  file?: string | undefined;
}

/**
 * The PDF flags off a parsed command line: `--format` is parsed into
 * `exportFlags`, and `--out`/`--file` into the `config` group that introduced
 * them; this reads them from there rather than parsing them a second time.
 */
export function pdfFlags(parsed: Pick<ParsedCli, "exportFlags" | "config">): PdfExportFlags {
  return {
    format: parsed.exportFlags.format,
    out: parsed.config.out,
    file: parsed.config.file,
  };
}

/**
 * True when the command should export a PDF instead of its usual output.
 * Any other `--format` is an error rather than silently ignored, and so is a
 * destination with no format: `--out report.pdf` alone reads like a request
 * for a file, and quietly printing a chart instead would be a surprise.
 */
export function wantsPdf(flags: PdfExportFlags, command: string): boolean {
  const format = flags.format?.trim().toLowerCase();
  if (format === undefined || format === "") {
    if (flags.out ?? flags.file) {
      throw new CliError(
        `--out/--file writes a file: add --format pdf (\`infrawrench ${command} <name|id> --format pdf --out <path>\`).`,
      );
    }
    return false;
  }
  if (format === "pdf") return true;
  throw new CliError(`Unknown --format "${flags.format}" for ${command}. The only format is pdf.`);
}

/** Download `path` (an org-scoped PDF route) and write it next to the user. */
export async function exportPdf(
  ctx: CliContext,
  opts: {
    orgId: string;
    path: string;
    flags: PdfExportFlags;
    /** The object's name: the default file name, and the JSON `name` field. */
    subject: { kind: "report" | "dashboard"; id: string; name: string };
  },
): Promise<void> {
  // The local zone as `?tz=`, so the PDF's "generated at" line reads in the
  // user's time (client-core's `withPdfTimezone`, re-derived: the CLI keeps
  // its client-core imports type-only).
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const path = tz
    ? `${opts.path}${opts.path.includes("?") ? "&" : "?"}tz=${encodeURIComponent(tz)}`
    : opts.path;
  const bytes = await orgFetchBytes(opts.orgId, path);
  // `%PDF-` is the first thing every PDF says. Anything else is an error
  // payload that slipped through with a 200, and writing it as `.pdf` would
  // only surface later as "the file is damaged".
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new CliError(
      `The server did not return a PDF for ${opts.subject.kind} "${opts.subject.name}".`,
    );
  }
  const target = resolve(opts.flags.out ?? opts.flags.file ?? pdfFileName(opts.subject.name));
  try {
    await writeFile(target, bytes);
  } catch (e) {
    throw new CliError(`Can't write ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (ctx.flags.output === "json") {
    printJson({
      org: opts.orgId,
      [opts.subject.kind]: { id: opts.subject.id, name: opts.subject.name },
      path: target,
      bytes: bytes.byteLength,
    });
    return;
  }
  println(
    `${c.green("✓")} ${c.bold(opts.subject.name)} ${c.dim(`→ ${target} (${formatBytes(bytes.byteLength)})`)}`,
  );
}
