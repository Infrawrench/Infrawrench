// Shared by `reports`, `dashboards` and `canvas` with `--format pdf` (and, for
// the file write, `compliance export`): download the server-rendered PDF and
// write it to disk. The rendering is the server's job (the same document the
// web download and the scheduled delivery attach), so the CLI only fetches
// bytes and picks a file name.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Option } from "effect";
import { CloudApi } from "./effect/cloud-api";
import { CliFailure } from "./effect/errors";
import * as Print from "./effect/print";
import { CliSession } from "./effect/session";
import { formatBytes, pdfFileName } from "./format";
import { c, safe } from "./output";

/**
 * Refuse a destination with no format: `--out report.pdf` alone reads like a
 * request for a file, and quietly printing a chart instead would be a surprise.
 * (Any `--format` other than pdf is refused when the line is parsed.)
 */
export const requirePdfForDestination = (
  pdf: boolean,
  target: Option.Option<string>,
  command: string,
): Effect.Effect<void, CliFailure> =>
  !pdf && Option.isSome(target)
    ? Effect.fail(
        new CliFailure({
          message: `--out/--file writes a file: add --format pdf (\`infrawrench ${command} <name|id> --format pdf --out <path>\`).`,
        }),
      )
    : Effect.void;

/**
 * Write a downloaded file (a PDF, the compliance evidence pack) relative to
 * the working directory, overwriting what is there; answers with the absolute
 * path. A write failure is one sentence naming the path, not a stack trace.
 */
export const writeDownloadedFile = (
  path: string,
  bytes: Uint8Array,
): Effect.Effect<string, CliFailure> => {
  const target = resolve(path);
  return Effect.tryPromise({
    try: () => writeFile(target, bytes),
    catch: (e) =>
      new CliFailure({
        message: `Can't write ${target}: ${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(Effect.as(target));
};

export interface PdfSubject {
  readonly kind: "report" | "dashboard" | "canvas";
  readonly id: string;
  readonly name: string;
}

/** Download `path` (an org-scoped PDF route) and write it next to the user. */
export const exportPdf = Effect.fnUntraced(function* (opts: {
  readonly orgId: string;
  readonly path: string;
  readonly target: Option.Option<string>;
  /** The object's name: the default file name, and the JSON `name` field. */
  readonly subject: PdfSubject;
}) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  // The local zone as `?tz=`, so the PDF's "generated at" line reads in the
  // user's time (client-core's `withPdfTimezone`, re-derived: the CLI keeps
  // its client-core imports type-only).
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const path = tz
    ? `${opts.path}${opts.path.includes("?") ? "&" : "?"}tz=${encodeURIComponent(tz)}`
    : opts.path;
  const { bytes } = yield* api.download(opts.orgId, path);
  // `%PDF-` is the first thing every PDF says. Anything else is an error
  // payload that slipped through with a 200, and writing it as `.pdf` would
  // only surface later as "the file is damaged".
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    return yield* new CliFailure({
      message: `The server did not return a PDF for ${opts.subject.kind} "${opts.subject.name}".`,
    });
  }
  const target = yield* writeDownloadedFile(
    Option.getOrElse(opts.target, () => pdfFileName(opts.subject.name)),
    bytes,
  );

  if (session.output === "json") {
    return yield* Print.json({
      org: opts.orgId,
      [opts.subject.kind]: { id: opts.subject.id, name: opts.subject.name },
      path: target,
      bytes: bytes.byteLength,
    });
  }
  yield* Print.line(
    `${c.green("✓")} ${c.bold(safe(opts.subject.name))} ${c.dim(`→ ${target} (${formatBytes(bytes.byteLength)})`)}`,
  );
});
