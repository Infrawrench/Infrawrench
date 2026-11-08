// The parsed global flags, as a service every command reads. The flags
// themselves are `effect/cli` shared
// flags on the root command (`root.ts`), so they parse anywhere on the line;
// the root turns them into a `CliSession` once, before any handler runs.
import { Context, Effect, Option } from "effect";
import { Flag } from "effect/cli";
import { setColorEnabled } from "../output";
import { CliUsageError } from "./errors";

export type OutputMode = "json" | "text";

/** What the bootstrap in `runCli` learned before parsing: the process, not the line. */
export class CliHost extends Context.Service<
  CliHost,
  {
    /** True when the GUI holds the single-instance lock: DB + tokens are read-only. */
    readonly guiRunning: boolean;
  }
>()("infrawrench/desktop/cli/CliHost") {}

export class CliSession extends Context.Service<
  CliSession,
  {
    readonly output: OutputMode;
    /** `--no-color` was not passed. Whether colour is *on* also needs a TTY and no NO_COLOR. */
    readonly color: boolean;
    readonly org: string | null;
    readonly local: boolean;
    readonly account: string | null;
    readonly guiRunning: boolean;
  }
>()("infrawrench/desktop/cli/CliSession") {}

/**
 * The flags every command accepts, before or after its name. A flag only one
 * command reads belongs on that command, not here.
 */
export const globalFlags = {
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print JSON (same as --output json)"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  text: Flag.Boolean("text").pipe(
    Flag.withDescription("Print text, the default (same as --output text)"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  output: Flag.Literals("output", ["json", "text"]).pipe(
    Flag.withAlias("o"),
    Flag.withDescription("Output mode"),
    Flag.optional,
  ),
  org: Flag.String("org").pipe(
    Flag.withMetavar("id|name"),
    Flag.withDescription("Scope to one organization (default: INFRAWRENCH_ORG, or your only one)"),
    Flag.optional,
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Scope to the local (desktop) workspace"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  account: Flag.String("account").pipe(
    Flag.withAlias("a"),
    Flag.withMetavar("id|name"),
    Flag.withDescription("Account id or name for resource commands"),
    Flag.optional,
  ),
  // `--no-color` is the spelling people type; `--color` is accepted as its
  // negation's opposite and is the default.
  color: Flag.Boolean("color").pipe(
    Flag.withDescription("ANSI colours (--no-color turns them off)"),
    Flag.withDefault(true),
  ),
};

export interface GlobalFlagValues {
  readonly json: boolean;
  readonly text: boolean;
  readonly output: Option.Option<OutputMode>;
  readonly org: Option.Option<string>;
  readonly local: boolean;
  readonly account: Option.Option<string>;
  readonly color: boolean;
}

/**
 * The parsed global flags plus the host, validated with the sentences the CLI
 * has always used for a contradictory pair. Also applies `--no-color` to
 * `output.ts`, which every printer reads.
 */
export const makeSession = Effect.fnUntraced(function* (flags: GlobalFlagValues) {
  const host = yield* CliHost;
  if (flags.json && flags.text) {
    return yield* new CliUsageError({ message: "--json and --text are mutually exclusive" });
  }
  const org = Option.getOrNull(flags.org);
  if (org && flags.local) {
    return yield* new CliUsageError({ message: "--org and --local are mutually exclusive" });
  }
  const output: OutputMode = flags.json
    ? "json"
    : flags.text
      ? "text"
      : Option.getOrElse(flags.output, (): OutputMode => "text");
  yield* Effect.sync(() =>
    setColorEnabled(flags.color && process.stdout.isTTY === true && !process.env.NO_COLOR),
  );
  return CliSession.of({
    output,
    color: flags.color,
    org,
    local: flags.local,
    account: Option.getOrNull(flags.account),
    guiRunning: host.guiRunning,
  });
});

/** True when the command should print JSON. */
export const isJson = CliSession.use((session) => Effect.succeed(session.output === "json"));
