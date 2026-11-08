// The range flags (`--last`, `--from`, `--to`, `--days`, `--limit`, `--kind`,
// `--resource`, `--window`, `--group-by`, `--series`, `--currency`,
// `--customer`, `--month`) as typed `Flag`s. Each command spreads in the subset
// it reads: `Command.make("tags", { ...dateRange }, ...)`.
//
// Parsing and every error sentence are the legacy parser's (`../args.ts`): a
// bad value is a parse error (the command's help and the sentence on stderr,
// exit 2) rather than a failure halfway through the command. The flag
// descriptions are generic; a command whose flag means something narrower
// pipes its own `Flag.withDescription` onto it.
//
// The rules that span two flags (`--days` past the endpoint's bound, a window
// that ends before it starts) stay in the command, as `CliUsageError`s.
import { Effect, Option } from "effect";
import { CliError, Flag } from "effect/cli";
import { parseDuration, parseLastDays } from "../args";
import { CliUsageError } from "./errors";

/** `flag`, its value checked by `parse`, which throws the legacy sentence. */
const parsedBy =
  <A>(parse: (text: string) => A) =>
  (flag: Flag.Flag<string>): Flag.Flag<A> =>
    flag.pipe(
      Flag.mapEffect((text) =>
        Effect.try({
          try: () => parse(text),
          catch: (error) =>
            new CliError.ValidationError({
              message: error instanceof Error ? error.message : String(error),
            }),
        }),
      ),
    );

/** `--<name>` as a whole number of at least 1, in `positiveInt`'s words. */
const positiveInt = (name: string): Flag.Flag<number> =>
  Flag.String(name).pipe(
    parsedBy((text) => {
      const value = Number(text);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--${name} must be a whole number of at least 1, got "${text}"`);
      }
      return value;
    }),
  );

/** `--last 30d|12w|3m`, as whole days (`parseLastDays`): the cost-style commands' span. */
export const lastDays = Flag.String("last").pipe(
  Flag.withMetavar("span"),
  Flag.withDescription("How far back: 7d, 30d, 12w or 3m"),
  parsedBy(parseLastDays),
  Flag.optional,
);

/** `--last 90m|6h|7d|2w`, in milliseconds (`parseDuration`): the metric-style span. */
export const lastDuration = Flag.String("last").pipe(
  Flag.withMetavar("span"),
  Flag.withDescription("How far back: 30m, 6h, 7d or 2w"),
  parsedBy(parseDuration),
  Flag.optional,
);

export const from = Flag.String("from").pipe(
  Flag.withMetavar("date"),
  Flag.withDescription("Start of the range (YYYY-MM-DD or an ISO timestamp)"),
  Flag.optional,
);

export const to = Flag.String("to").pipe(
  Flag.withMetavar("date"),
  Flag.withDescription("End of the range (YYYY-MM-DD or an ISO timestamp)"),
  Flag.optional,
);

/** `--days <n>`: the whole-day window an endpoint's `days` parameter takes. */
export const days = positiveInt("days").pipe(
  Flag.withMetavar("n"),
  Flag.withDescription("Whole-day window (--last says the same thing)"),
  Flag.optional,
);

/** `--limit <n>`: a listing's row cap. */
export const limit = positiveInt("limit").pipe(
  Flag.withMetavar("n"),
  Flag.withDescription("Row cap"),
  Flag.optional,
);

export const kind = Flag.String("kind").pipe(Flag.withDescription("Filter by kind"), Flag.optional);

export const resource = Flag.String("resource").pipe(
  Flag.withMetavar("id"),
  Flag.withDescription("Focus on one resource"),
  Flag.optional,
);

/** `-w/--window 15m|1h|6h`, in milliseconds: a ± half-width around a centre. */
export const halfWindow = Flag.String("window").pipe(
  Flag.withAlias("w"),
  Flag.withMetavar("span"),
  Flag.withDescription("Half-window around the timestamp: 15m, 1h or 6h"),
  parsedBy(parseDuration),
  Flag.optional,
);

export const groupBy = Flag.String("group-by").pipe(
  Flag.withMetavar("dimension"),
  Flag.withDescription("Break the figures down by this dimension"),
  Flag.optional,
);

export const series = Flag.String("series").pipe(
  Flag.withMetavar("label"),
  Flag.withDescription("Only series whose label contains this"),
  Flag.optional,
);

export const currency = Flag.String("currency").pipe(
  Flag.withMetavar("code"),
  Flag.withDescription("Three-letter currency code, e.g. USD"),
  Flag.optional,
);

export const customer = Flag.String("customer").pipe(
  Flag.withMetavar("name|id"),
  Flag.withDescription("One managed account (customer)"),
  Flag.optional,
);

export const month = Flag.String("month").pipe(
  Flag.withMetavar("YYYY-MM"),
  Flag.withDescription("Which month"),
  parsedBy((text) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text))
      throw new Error(`--month must be YYYY-MM, got "${text}"`);
    return text;
  }),
  Flag.optional,
);

/** `--last`, `--from` and `--to` for a command that asks for whole days. */
export const dateRange = { last: lastDays, from, to };

/** What {@link resolveDateRange} reads. */
export interface DateRangeInput {
  readonly last: Option.Option<number>;
  readonly from: Option.Option<string>;
  readonly to: Option.Option<string>;
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The `from`/`to` days (YYYY-MM-DD, inclusive, UTC) for the cost-style
 * commands: explicit `--from`/`--to` win, `--last` sizes the window ending at
 * `to`, and neither means `defaultDays` (30) ending today. `args.ts`'s
 * `resolveDateRange`, over parsed flags.
 */
export function resolveDateRange(
  range: DateRangeInput,
  defaultDays = 30,
): { from: string; to: string } {
  const span = Option.match(range.last, {
    onNone: () => defaultDays,
    onSome: (last) => Math.max(1, Math.round(last)),
  });
  const to = Option.getOrElse(range.to, () => isoDay(Date.now()));
  const from = Option.getOrElse(range.from, () => isoDay(Date.parse(to) - (span - 1) * 86_400_000));
  return { from, to };
}

/**
 * The day window to ask the server for: `--days` wins, `--last` is converted,
 * neither is `defaultDays`. Past `max` is the legacy usage error. `args.ts`'s
 * `resolveDayWindow`, over parsed flags.
 */
export const resolveDayWindow = (
  range: { readonly days: Option.Option<number>; readonly last: Option.Option<number> },
  defaultDays: number,
  max: number,
): Effect.Effect<number, CliUsageError> => {
  const asked = Option.orElse(range.days, () =>
    Option.map(range.last, (last) => Math.max(1, Math.round(last))),
  );
  if (Option.isNone(asked)) return Effect.succeed(defaultDays);
  if (asked.value > max) {
    return Effect.fail(
      new CliUsageError({
        message: `Window too large. The server accepts at most ${max} days, asked for ${asked.value}.`,
      }),
    );
  }
  return Effect.succeed(asked.value);
};
