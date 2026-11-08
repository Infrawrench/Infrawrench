// `--reason` and `--status`, the triage flags: why a finding is an accepted
// risk (`posture`/`vulns dismiss`), why access is wanted (`jit request`), a
// dismissal's category (`leaks dismiss`, `costs --anomalies feedback`), and
// which states a queue lists (`leaks`, `jit`). One definition each, spread
// into the commands that read them; each command says what the flag means
// there and, when the value is one of a fixed set, how it is checked.
//
// A checked value fails at parse time in the command's legacy sentence (the
// command's help and the sentence on stderr, exit 2), like the range flags.
import { Effect, Option } from "effect";
import { CliError, Flag } from "effect/cli";

export interface TriageFlagOptions {
  /** What the flag means for this command: its line in the command's help. */
  readonly description: string;
  /** The value's placeholder in help: `text`, or the accepted values joined with `|`. */
  readonly metavar?: string | undefined;
}

/**
 * The value checked by `parse`, which sees the flag as given (absent
 * included) and throws an `Error` whose message is the refusal.
 */
const checked =
  <A>(parse: (raw: Option.Option<string>) => A) =>
  (flag: Flag.Flag<Option.Option<string>>): Flag.Flag<A> =>
    flag.pipe(
      Flag.mapEffect((raw) =>
        Effect.try({
          try: () => parse(raw),
          catch: (error) =>
            new CliError.ValidationError({
              message: error instanceof Error ? error.message : String(error),
            }),
        }),
      ),
    );

const optionalString = (name: string, options: TriageFlagOptions) =>
  Flag.String(name).pipe(
    Flag.withMetavar(options.metavar ?? "text"),
    Flag.withDescription(options.description),
    Flag.optional,
  );

/** `--reason <text>`, passed on as typed: free text the server keeps with the decision. */
export const reason = (options: TriageFlagOptions): Flag.Flag<Option.Option<string>> =>
  optionalString("reason", options);

/** `--reason`, one of a fixed set: `parse` answers the value or throws the refusal. */
export const reasonOf = <A>(
  options: TriageFlagOptions & { readonly parse: (raw: Option.Option<string>) => A },
): Flag.Flag<A> => optionalString("reason", options).pipe(checked(options.parse));

/** `--status <s>`, passed on as typed: a filter the server checks. */
export const status = (options: TriageFlagOptions): Flag.Flag<Option.Option<string>> =>
  optionalString("status", options);

/** `--status`, one of a fixed set: `parse` answers the value or throws the refusal. */
export const statusOf = <A>(
  options: TriageFlagOptions & { readonly parse: (raw: Option.Option<string>) => A },
): Flag.Flag<A> => optionalString("status", options).pipe(checked(options.parse));
