// Flag parsing for the CLI. Built on node:util parseArgs (no dependency);
// subcommand routing happens in main.ts over the returned positionals.
import { parseArgs } from "node:util";
import { CliError, type CliFlags } from "./context";

export interface RangeFlags {
  last?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  groupBy?: string | undefined;
  series?: string | undefined;
  type?: string | undefined;
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
  positionals: string[];
  version: boolean;
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

  return {
    flags: {
      output,
      color: !values["no-color"],
      org: str("org") ?? null,
      local: values.local === true,
      account: str("account") ?? null,
      help: values.help === true,
    },
    range: {
      last: str("last"),
      from: str("from"),
      to: str("to"),
      groupBy: str("group-by"),
      series: str("series"),
      type: str("type"),
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
  };
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
