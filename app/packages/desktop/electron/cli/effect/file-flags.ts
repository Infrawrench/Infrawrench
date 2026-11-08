// The file flags (`--format`, `--out`, `-f/--file`) as typed `Flag`s, for the
// commands that write a document rather than print one: a report's PDF, a
// CSV export, the compliance evidence pack, an asciicast. Each command
// spreads in the ones it reads: `Command.make("x", { ...destination, format: formatOf(...) })`.
//
// `--out` and `--file` are two flags, not one with an alias, because the
// legacy parser read them as two (`--out` winning when both are given) and a
// script that passes both keeps working. `--format` is per command: the set of
// formats and the sentence that refuses anything else are the command's own,
// checked at parse time (the command's help and the sentence on stderr, exit 2).
//
// A rule that spans two flags (a destination with no format to write) stays
// in the command, as a `CliFailure`.
import { writeFileSync } from "node:fs";
import { Effect, Option, Schema } from "effect";
import { CliError, Flag } from "effect/cli";
import { c } from "../output";
import * as Print from "./print";

/** `--out <path>`: where the file is written; stdout (or a default name) without it. */
export const out = Flag.String("out").pipe(
  Flag.withMetavar("path"),
  Flag.withDescription("Write the file to this path"),
  Flag.optional,
);

/** `-f/--file <path>`: `--out` under the name config-as-code introduced. */
export const file = Flag.String("file").pipe(
  Flag.withAlias("f"),
  Flag.withMetavar("path"),
  Flag.withDescription("Same as --out"),
  Flag.optional,
);

/** `--out` and `--file`, for a command that writes to either. */
export const destination = { out, file };

/** What {@link destinationOf} reads. */
export interface DestinationInput {
  readonly out: Option.Option<string>;
  readonly file: Option.Option<string>;
}

/** The path to write: `--out`, else `--file` (the legacy `out ?? file`). */
export const destinationOf = (input: DestinationInput): Option.Option<string> =>
  Option.orElse(input.out, () => input.file);

const refuse = (message: string) => Effect.fail(new CliError.ValidationError({ message }));

/**
 * `--format <x>`, one of `choices` exactly as typed, else `refusal(value)` as
 * the parse error. Absent is `Option.none()`.
 */
export const formatOf = <const C extends ReadonlyArray<string>>(
  choices: C,
  refusal: (value: string) => string,
): Flag.Flag<Option.Option<C[number]>> => {
  const decode = Schema.decodeUnknownOption(Schema.Literals(choices));
  return Flag.String("format").pipe(
    Flag.withMetavar(choices.join("|")),
    Flag.withDescription(`Write the result as ${choices.join(" or ")} instead of printing it`),
    Flag.mapEffect((text) =>
      Option.match(decode(text), { onNone: () => refuse(refusal(text)), onSome: Effect.succeed }),
    ),
    Flag.optional,
  );
};

/**
 * `--format pdf` for `command`: true when the PDF was asked for. Case and
 * surrounding space are ignored and an empty value is the same as none; any
 * other format is refused in `wantsPdf`'s words.
 */
export const pdfFormat = (command: string): Flag.Flag<boolean> =>
  Flag.String("format").pipe(
    Flag.withMetavar("pdf"),
    Flag.withDescription("Save the server-rendered PDF instead of printing (see --out)"),
    Flag.optional,
    Flag.mapEffect((format) => {
      const wanted = Option.getOrElse(format, () => "")
        .trim()
        .toLowerCase();
      if (wanted === "") return Effect.succeed(false);
      if (wanted === "pdf") return Effect.succeed(true);
      return refuse(
        `Unknown --format "${Option.getOrElse(format, () => "")}" for ${command}. The only format is pdf.`,
      );
    }),
  );

/**
 * A document written to `--out` (a line saying so on stdout) or, without one,
 * passed to stdout untouched, so it pipes. The path is taken as given and an
 * existing file is overwritten, as `writeFileSync` does.
 */
export const writeOrPrint = (target: Option.Option<string>, text: string): Effect.Effect<void> =>
  Option.match(target, {
    onNone: () => Print.write(text),
    onSome: (path) =>
      Effect.sync(() => writeFileSync(path, text, "utf8")).pipe(
        Effect.andThen(Print.line(c.dim(`Wrote ${path}`))),
      ),
  });
