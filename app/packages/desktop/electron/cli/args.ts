// Flag parsing for the CLI. Built on node:util parseArgs (no dependency);
// subcommand routing happens in main.ts over the returned positionals.
import { parseArgs } from "node:util";
import { CliError, type CliFlags } from "./context";
import type { FanoutFlags } from "./commands/ssh-fanout";
import type { DiffFlags } from "./commands/diff";
import type { ConfigFlags } from "./commands/config";

export interface RangeFlags {
  last?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  groupBy?: string | undefined;
  series?: string | undefined;
  type?: string | undefined;
  /**
   * Explicit whole-day window for endpoints that take a `days` query param
   * (`costs --anomalies`, `changes`). `--last 14d` says the same thing; this
   * exists because the server-side parameter is literally named `days` and
   * scripts read better spelling it the same way.
   */
  days?: number | undefined;
  /** Row cap for listings (`changes`) — maps to the endpoint's `pageSize`. */
  limit?: number | undefined;
  /** `changes` filter: created | updated | deleted. */
  kind?: string | undefined;
  /** Resource id to filter/focus on (`changes`, `graph`). */
  resource?: string | undefined;
  /**
   * `moment` half-window, in `parseDuration` form (`30m`, `6h`). Named apart
   * from `--last` because it is a ± around a centre, not a lookback.
   */
  window?: string | undefined;
  /**
   * `costs --basis cash|amortized` — which number to sum. Left as a raw string
   * so the command validates it and can name the valid values in the error,
   * the way `--group-by` does.
   */
  basis?: string | undefined;
  /**
   * `costs --charge-type <t>`, repeatable: keep only these kinds of charge.
   * Empty means every kind, which is what makes the default total net.
   */
  chargeTypes?: string[] | undefined;
  /**
   * `costs --currency <code>` — fold every currency the org holds a rate for
   * into this one, so a mixed-currency org gets a single number.
   *
   * Opt-in and inert without it: absent, the field is not sent at all and the
   * server answers exactly as it always did. Conversion also requires the org
   * to have configured that display currency and stated the rates, because
   * Infrawrench never fetches live FX. Left a raw string so the command
   * validates the shape and can say what it expected.
   */
  currency?: string | undefined;
  /**
   * `costs --where "provider = 'aws' AND tag['env'] != 'dev'"` — the cost
   * filter in the cost query language.
   *
   * Left a raw string: the command compiles it with the shared parser from
   * `@infrawrench/client-core` so a mistake is reported with its offset and a
   * caret, which a generic flag error here could not do.
   */
  where?: string | undefined;
}

/** Flags for the push-up commands (`page`, `costs push`). */
export interface PushFlags {
  /** Name of the system raising the page / owning the cost rows. */
  source?: string | undefined;
  /** Paging throttle key; the server defaults it to "default". */
  key?: string | undefined;
  title?: string | undefined;
  /** Minutes to suppress repeat pages under the same key. */
  cooldown?: number | undefined;
  voice: boolean;
  /** JSON file of cost rows; stdin when absent. */
  file?: string | undefined;
}

/** Flags for `deploy`. */
export interface DeployFlags {
  /** Which environment to deploy. Omitted is fine when the Infrafile declares one. */
  env?: string | undefined;
  /** Stop after plan(): print the plan and Dockerfile, build nothing. */
  plan: boolean;
  /** `key=value` answers for `select(key, ...)`, so a deploy can run unattended. */
  set: string[];
  /**
   * Run id to roll back to. Omitted, `deploy rollback` picks the last success.
   * Named `--to-run` because `--to` is already the time-range end.
   */
  toRun?: string | undefined;
  /**
   * `deploy rollback` only: also delete the resources that runs after the
   * target created through `infra.accounts` — undo the provisioning, not just
   * the shipping. Destructive, so it is never the default.
   */
  deleteCreated: boolean;
  /**
   * `deploy destroy` only: skip the Infrafile and delete what the local ledger
   * says this env's runs created. Requires an explicit `--env`.
   */
  created: boolean;
}

/** Flags for `export`. */
export interface ExportFlags {
  /** Export format. Only "terraform" today; validated in the command. */
  format?: string | undefined;
}

export interface ParsedCli {
  flags: CliFlags;
  range: RangeFlags;
  push: PushFlags;
  deploy: DeployFlags;
  exportFlags: ExportFlags;
  fanout: FanoutFlags;
  diff: DiffFlags;
  config: ConfigFlags;
  positionals: string[];
  version: boolean;
  /** `costs --anomalies` — the spend-spike list instead of the spend chart. */
  anomalies: boolean;
}

export function parseCliArgs(argv: string[]): ParsedCli {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        text: { type: "boolean", default: false },
        output: { type: "string", short: "o" },
        org: { type: "string" },
        local: { type: "boolean", default: false },
        account: { type: "string", short: "a" },
        "no-color": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
        // Range flags used by metrics/costs; parsed globally so `--last`
        // can appear anywhere on the line.
        last: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        "group-by": { type: "string" },
        series: { type: "string" },
        type: { type: "string" },
        days: { type: "string" },
        limit: { type: "string" },
        kind: { type: "string" },
        resource: { type: "string" },
        // `moment` half-window (± around the timestamp).
        window: { type: "string", short: "w" },
        // `costs` money selectors: which number, and which kinds of charge.
        basis: { type: "string" },
        currency: { type: "string" },
        // `costs --where "<cost query>"` — the filter, as text.
        where: { type: "string" },
        // Repeatable: one --charge-type per kind to keep.
        "charge-type": { type: "string", multiple: true },
        // `costs --anomalies` — same command, different question.
        anomalies: { type: "boolean", default: false },
        // `posture dismiss` — why the finding is an accepted risk.
        reason: { type: "string" },
        // Push-up flags (`page`, `costs push`).
        source: { type: "string" },
        key: { type: "string" },
        title: { type: "string" },
        cooldown: { type: "string" },
        voice: { type: "boolean", default: false },
        file: { type: "string", short: "f" },
        // Export flags (`export`).
        format: { type: "string" },
        // Deploy flags (`deploy`).
        env: { type: "string", short: "e" },
        plan: { type: "boolean", default: false },
        // Repeatable: one --set per select() key the Infrafile asks about.
        set: { type: "string", multiple: true },
        "to-run": { type: "string" },
        "delete-created": { type: "boolean", default: false },
        created: { type: "boolean", default: false },
        // Fan-out SSH flags (`ssh-fanout`). `--list` and `--yes` are booleans;
        // the rest narrow the host set or supply credentials.
        list: { type: "boolean", default: false },
        hosts: { type: "string" },
        plugin: { type: "string" },
        tag: { type: "string" },
        user: { type: "string" },
        snippet: { type: "string" },
        yes: { type: "boolean", short: "y", default: false },
        concurrency: { type: "string" },
        // Environment diff (`diff`). `-a` is the existing account flag, so the
        // second side needs one of its own.
        against: { type: "string", short: "b" },
        all: { type: "boolean", default: false },
        // Config-as-code flags (`config`). `--file` doubles as the export
        // destination; `--out` is the name that reads right when writing.
        out: { type: "string" },
        sections: { type: "string" },
        prune: { type: "boolean", default: false },
      },
    });
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), 2);
  }

  const values = parsed.values as Record<string, string | boolean | undefined>;

  let output: CliFlags["output"] = "text";
  if (values.output !== undefined) {
    if (values.output !== "json" && values.output !== "text") {
      throw new CliError(`--output must be "json" or "text", got "${String(values.output)}"`, 2);
    }
    output = values.output;
  }
  if (values.json) output = "json";
  if (values.text) output = "text";
  if (values.json && values.text) {
    throw new CliError("--json and --text are mutually exclusive", 2);
  }

  if (values.org && values.local) {
    throw new CliError("--org and --local are mutually exclusive", 2);
  }

  const str = (key: string): string | undefined =>
    typeof values[key] === "string" ? (values[key] as string) : undefined;

  // `multiple: true` options come back as arrays, which the `values` cast above
  // flattens away — read them off the untyped parse result instead.
  const multi = parsed.values as Record<string, string[] | undefined>;

  const cooldownText = str("cooldown");
  let cooldown: number | undefined;
  if (cooldownText !== undefined) {
    cooldown = Number(cooldownText);
    if (!Number.isInteger(cooldown) || cooldown < 0) {
      throw new CliError(`--cooldown must be a whole number of minutes, got "${cooldownText}"`, 2);
    }
  }

  /** A flag that must be a positive whole number, or a single-line error. */
  const positiveInt = (key: string): number | undefined => {
    const text = str(key);
    if (text === undefined) return undefined;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1) {
      throw new CliError(`--${key} must be a whole number of at least 1, got "${text}"`, 2);
    }
    return value;
  };

  return {
    flags: {
      output,
      color: !values["no-color"],
      org: str("org") ?? null,
      local: values.local === true,
      account: str("account") ?? null,
      reason: str("reason") ?? null,
      help: values.help === true,
    },
    range: {
      last: str("last"),
      from: str("from"),
      to: str("to"),
      groupBy: str("group-by"),
      series: str("series"),
      type: str("type"),
      days: positiveInt("days"),
      limit: positiveInt("limit"),
      kind: str("kind"),
      resource: str("resource"),
      window: str("window"),
      basis: str("basis"),
      currency: str("currency"),
      where: str("where"),
      chargeTypes: Array.isArray(multi["charge-type"]) ? multi["charge-type"] : [],
    },
    deploy: {
      env: str("env"),
      plan: values.plan === true,
      set: Array.isArray(multi.set) ? multi.set : [],
      toRun: str("to-run"),
      deleteCreated: values["delete-created"] === true,
      created: values.created === true,
    },
    exportFlags: {
      format: str("format"),
    },
    diff: {
      against: str("against"),
      all: values.all === true,
    },
    fanout: {
      list: values.list === true,
      hosts: str("hosts"),
      plugin: str("plugin"),
      tag: str("tag"),
      key: str("key"),
      user: str("user"),
      snippet: str("snippet"),
      yes: values.yes === true,
      concurrency: positiveInt("concurrency"),
    },
    config: {
      file: str("file"),
      out: str("out"),
      sections: str("sections"),
      prune: values.prune === true,
      yes: values.yes === true,
    },
    push: {
      source: str("source"),
      key: str("key"),
      title: str("title"),
      cooldown,
      voice: values.voice === true,
      file: str("file"),
    },
    positionals: parsed.positionals,
    version: values.version === true,
    anomalies: values.anomalies === true,
  };
}

/**
 * `--last 30d|12w|3m` for the day-granularity commands (costs, anomalies,
 * changes). Separate from `parseDuration` because those spans are whole days
 * and accept months, which minutes/hours never do.
 */
export function parseLastDays(text: string): number {
  const match = /^(\d+)([dwm])$/.exec(text);
  if (!match) {
    throw new CliError(`Invalid --last "${text}" — use forms like 7d, 30d, 12w, 3m`, 2);
  }
  const n = Number(match[1]);
  return n * { d: 1, w: 7, m: 30 }[match[2] as "d" | "w" | "m"]!;
}

/**
 * The day window a command should ask the server for: an explicit `--days`
 * wins, `--last` is converted, and neither means the caller's default. Bounds
 * are the endpoint's own, checked here so a typo fails before the round trip.
 */
export function resolveDayWindow(range: RangeFlags, defaultDays: number, max: number): number {
  const days =
    range.days ?? (range.last ? Math.max(1, Math.round(parseLastDays(range.last))) : null);
  if (days === null) return defaultDays;
  if (days > max) {
    throw new CliError(
      `Window too large — the server accepts at most ${max} days, asked for ${days}.`,
      2,
    );
  }
  return days;
}

const DURATION_RE = /^(\d+)([mhdw])$/;

/** Parse `--last 90m|6h|7d|2w` into milliseconds. */
export function parseDuration(text: string): number {
  const match = DURATION_RE.exec(text);
  if (!match) {
    throw new CliError(`Invalid duration "${text}" — use forms like 30m, 6h, 7d, 2w`, 2);
  }
  const n = Number(match[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[match[2]!]!;
  return n * unit;
}
