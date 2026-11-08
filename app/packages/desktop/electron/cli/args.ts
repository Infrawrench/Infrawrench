// Flag parsing for the CLI. Built on node:util parseArgs (no dependency);
// subcommand routing happens in main.ts over the returned positionals.
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { CliError, type CliFlags } from "./context";
import type { JitFlags } from "./commands/jit";

/** The range flags the remaining legacy commands read (`prices`, `vulns`, `diff`). */
export interface RangeFlags {
  type?: string | undefined;
  /** Row cap for listings (`vulns`, `prices`). */
  limit?: number | undefined;
  /** Resource id to filter to (`vulns`). */
  resource?: string | undefined;
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
   * target created through `infra.accounts`; undo the provisioning, not just
   * the shipping. Destructive, so it is never the default.
   */
  deleteCreated: boolean;
  /**
   * `deploy destroy` only: skip the Infrafile and delete what the local ledger
   * says this env's runs created. Requires an explicit `--env`.
   */
  created: boolean;
}

// The per-command flag interfaces below live here, with the parser that fills
// them, rather than in their command modules: `args.ts` describing `ParsedCli`
// must not import from `commands/*`, because commands import the shared range
// helpers from here and the reverse edge closes an import cycle (diff.ts once
// did exactly that).

/** Flags specific to `ssh-fanout`. */
export interface FanoutFlags {
  /** Only list the selectable hosts. */
  list: boolean;
  /** Substring match on host label / host / tag. */
  hosts?: string | undefined;
  /** Restrict to one plugin. */
  plugin?: string | undefined;
  /** Restrict to hosts carrying this `key:value` tag. */
  tag?: string | undefined;
  /** Org SSH key (id or name) for VM targets. */
  key?: string | undefined;
  /** Username override for VM targets. */
  user?: string | undefined;
  /** Run a saved snippet by name instead of a literal command. */
  snippet?: string | undefined;
  /** Skip the "Run on N hosts?" confirmation. */
  yes: boolean;
  concurrency?: number | undefined;
}

/** Flags for `apps`: listing a host's applications, or opening one. */
export interface AppsFlags {
  /** Path to a private key for the connection. */
  key?: string | undefined;
  /** Login name, when the host's is not the resource type's default. */
  user?: string | undefined;
  /** Open this application in the desktop app instead of listing. */
  launch?: string | undefined;
  /** Report what the host is missing before applications can run there. */
  check: boolean;
  /** Install what `--check` found missing, using the host's package manager. */
  install: boolean;
}

/** How `diff`'s two accounts were named on the command line. */
export interface DiffFlags {
  /** `-b` / `--against`: the compared account. `-a` supplies the baseline. */
  against?: string | undefined;
  /** `--all`: compare identity/timestamp fields too, instead of hiding them. */
  all: boolean;
}

/** Flags `config` reads off the command line. */
export interface ConfigFlags {
  /** `--file <path>`; stdin when omitted (apply/plan), stdout (export). */
  file?: string | undefined;
  /** `--out <path>` for export: `--file` also works, this is the readable name. */
  out?: string | undefined;
  /** `--sections a,b`: narrow the export, or the document sent to plan/apply. */
  sections?: string | undefined;
  /** `--prune`: delete what the document doesn't name (mode `replace`). */
  prune: boolean;
  /** `-y/--yes`: skip the confirmation an apply otherwise asks for. */
  yes: boolean;
}

/**
 * `prices search|compare` filters, kept as the raw strings typed: the
 * command hands them to client-core's query normalizers, the same ones the
 * server applies to a query string, so the CLI cannot drift from the route.
 */
export interface PriceFlags {
  provider?: string | undefined;
  region?: string | undefined;
  area?: string | undefined;
  rate?: string | undefined;
  term?: string | undefined;
  vcpus?: string | undefined;
  memory?: string | undefined;
  minVcpus?: string | undefined;
  maxVcpus?: string | undefined;
  minMemory?: string | undefined;
  maxMemory?: string | undefined;
  gpu?: string | undefined;
  gpus?: string | undefined;
  gpuModel?: string | undefined;
  maxPrice?: string | undefined;
  sort?: string | undefined;
  desc: boolean;
}

/** Flags for `pr-check`. */
export interface PrCheckFlags {
  /** `--repo owner/name`: whose settings and Terraform state mapping apply. */
  repo?: string | undefined;
  /** `--pr <n>`: preview a pull request through the GitHub App instead of a local diff. */
  pr?: number | undefined;
  /** `--base <ref>`: what the local diff compares against (default: the upstream default branch). */
  base?: string | undefined;
}

/** Flags for `seats`. */
export interface BulkFlags {
  /** `-y/--yes`: skip the confirmation `seats` otherwise asks for. */
  yes: boolean;
}

/**
 * `vulns` filters. Severities stay a raw comma-separated string so the command
 * validates them and can name the valid values in the error.
 */
export interface VulnsFlags {
  /** `--severity critical,high`. */
  severity?: string | undefined;
  /** `--running` / `--not-running`: true, false, or undefined for both. */
  running?: boolean | undefined;
  /** `--fix-available`: only findings the scanner says have a fix. */
  fixAvailable: boolean;
  /** `--kev`: only findings in the CISA KEV catalog. */
  kev: boolean;
  /** `--plugin <id>`: only findings this plugin reported. */
  plugin?: string | undefined;
  /** `--search <text>`: substring over advisory, aliases, package, artifact, title. */
  search?: string | undefined;
  /** `--include-dismissed`: also list (and, with --json, keep) the dismissed rows. */
  includeDismissed: boolean;
  /** `--service <id|slug|name>`: only findings running on a resource of this service. */
  service?: string | undefined;
}

export interface ParsedCli {
  flags: CliFlags;
  prices: PriceFlags;
  bulk: BulkFlags;
  prCheck: PrCheckFlags;
  range: RangeFlags;
  deploy: DeployFlags;
  fanout: FanoutFlags;
  apps: AppsFlags;
  diff: DiffFlags;
  config: ConfigFlags;
  vulns: VulnsFlags;
  positionals: string[];
  version: boolean;
  /** `jit` flags: raw strings, validated by the command. */
  jit: JitFlags;
  /** `services --tier 1`: only services of this criticality tier (1-4). */
  tier: number | undefined;
  /** `leaks` flags. `--reason`, `--account` and `--status` are the shared ones. */
  leaks: LeakFlags;
}

export interface LeakFlags {
  /** `--status open|rotated|dismissed|resolved|all`, validated by the command. */
  status: string | undefined;
  /** `leaks dismiss --comment`: a note kept with the dismissal. */
  comment: string | undefined;
  /** `leaks rotate --value-stdin`: read the replacement value from stdin, never argv. */
  valueStdin: boolean;
  /** `--keep-upstream-open`: leave the finding open on the scanner. */
  keepUpstreamOpen: boolean;
}

/**
 * The flags every command takes, before or after its name. Migrated commands
 * declare these as `effect/cli` shared flags (`effect/session.ts`); they stay
 * here too because {@link scanCommandLine} must step over their values to
 * find the command word.
 */
const GLOBAL_OPTIONS = {
  json: { type: "boolean", default: false },
  text: { type: "boolean", default: false },
  output: { type: "string", short: "o" },
  org: { type: "string" },
  local: { type: "boolean", default: false },
  account: { type: "string", short: "a" },
  "no-color": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} satisfies ParseArgsOptionsConfig;

/**
 * Every flag the legacy switch in `main.ts` reads, parsed globally. When a
 * command moves to `effect/cli`, the flags only it read leave this table (and
 * {@link ParsedCli}) and become `Flag`s on that command.
 */
const LEGACY_OPTIONS = {
  ...GLOBAL_OPTIONS,
  // Range flags the remaining legacy commands read: `diff --type`,
  // `vulns`/`prices --limit`, `vulns --resource`.
  type: { type: "string" },
  limit: { type: "string" },
  resource: { type: "string" },
  // `posture`/`vulns dismiss`, `leaks dismiss`, `jit request`: why.
  reason: { type: "string" },
  // `apps --key`, `ssh-fanout --key`: which key to connect with.
  key: { type: "string" },
  // `config plan|apply -f <file>`, `config export --out <file>`.
  file: { type: "string", short: "f" },
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
  launch: { type: "string" },
  // `apps --check` / `apps --install`: what a Linux host is missing before
  // applications can run there, and installing it.
  check: { type: "boolean", default: false },
  install: { type: "boolean", default: false },
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
  // Price catalog (`prices search|compare`).
  provider: { type: "string" },
  region: { type: "string" },
  area: { type: "string" },
  rate: { type: "string" },
  term: { type: "string" },
  vcpus: { type: "string" },
  memory: { type: "string" },
  "min-vcpus": { type: "string" },
  "max-vcpus": { type: "string" },
  "min-memory": { type: "string" },
  "max-memory": { type: "string" },
  gpu: { type: "string" },
  gpus: { type: "string" },
  "gpu-model": { type: "string" },
  "max-price": { type: "string" },
  sort: { type: "string" },
  desc: { type: "boolean", default: false },
  // `jit request|extend|list`: which policy and role, for how long, and
  // filters on the queue. `--reason` is the shared one.
  note: { type: "string" },
  policy: { type: "string" },
  role: { type: "string" },
  scope: { type: "string" },
  for: { type: "string" },
  by: { type: "string" },
  ticket: { type: "string" },
  status: { type: "string" },
  mine: { type: "boolean", default: false },
  holding: { type: "boolean", default: false },
  // `leaks`: a dismissal's note, the replacement value's source (stdin
  // only: a secret on argv lands in shell history), and whether to
  // leave the finding open on the scanner.
  comment: { type: "string" },
  "value-stdin": { type: "boolean", default: false },
  "keep-upstream-open": { type: "boolean", default: false },
  // `vulns` filters. `--plugin`, `--limit` and `-a/--account` are shared.
  severity: { type: "string" },
  running: { type: "boolean", default: false },
  "not-running": { type: "boolean", default: false },
  "fix-available": { type: "boolean", default: false },
  kev: { type: "boolean", default: false },
  search: { type: "string" },
  "include-dismissed": { type: "boolean", default: false },
  service: { type: "string" },
  // `pr-check`: a pull request by number, or a local diff against a base.
  repo: { type: "string" },
  pr: { type: "string" },
  base: { type: "string" },
  // `services --tier <1-4>`.
  tier: { type: "string" },
} satisfies ParseArgsOptionsConfig;

/**
 * The command word, found without validating anything: `runCli` uses it to
 * choose between `effect/cli` (a migrated command, which parses its own line)
 * and the legacy switch. Non-strict, so a flag this table does not know never
 * fails here; it reads as a boolean, which is how it can misplace the command
 * word only when an unknown flag's value precedes it, and then the legacy
 * parser rejects the line anyway. `noColor` is read early so help and parse
 * errors from `effect/cli` are already uncoloured.
 */
export function scanCommandLine(argv: string[]): { command: string | undefined; noColor: boolean } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: LEGACY_OPTIONS,
  });
  return { command: positionals[0], noColor: values["no-color"] === true };
}

export function parseCliArgs(argv: string[]): ParsedCli {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: LEGACY_OPTIONS,
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
  // flattens away: read them off the untyped parse result instead.
  const multi = parsed.values as Record<string, string[] | undefined>;

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

  /** A whole number within bounds, or a single-line error naming them. */
  const boundedInt = (key: string, min: number, max: number): number | undefined => {
    const text = str(key);
    if (text === undefined) return undefined;
    const value = Number(text);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new CliError(`--${key} must be a whole number from ${min} to ${max}, got "${text}"`, 2);
    }
    return value;
  };

  if (values.running && values["not-running"]) {
    throw new CliError("--running and --not-running are mutually exclusive", 2);
  }

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
    prCheck: {
      repo: str("repo"),
      pr: positiveInt("pr"),
      base: str("base"),
    },
    bulk: {
      yes: values.yes === true,
    },
    range: {
      type: str("type"),
      limit: positiveInt("limit"),
      resource: str("resource"),
    },
    deploy: {
      env: str("env"),
      plan: values.plan === true,
      set: Array.isArray(multi.set) ? multi.set : [],
      toRun: str("to-run"),
      deleteCreated: values["delete-created"] === true,
      created: values.created === true,
    },
    diff: {
      against: str("against"),
      all: values.all === true,
    },
    apps: {
      key: str("key"),
      user: str("user"),
      launch: str("launch"),
      check: values.check === true,
      install: values.install === true,
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
    prices: {
      provider: str("provider"),
      region: str("region"),
      area: str("area"),
      rate: str("rate"),
      term: str("term"),
      vcpus: str("vcpus"),
      memory: str("memory"),
      minVcpus: str("min-vcpus"),
      maxVcpus: str("max-vcpus"),
      minMemory: str("min-memory"),
      maxMemory: str("max-memory"),
      gpu: str("gpu"),
      gpus: str("gpus"),
      gpuModel: str("gpu-model"),
      maxPrice: str("max-price"),
      sort: str("sort"),
      desc: values.desc === true,
    },
    vulns: {
      severity: str("severity"),
      running: values.running === true ? true : values["not-running"] === true ? false : undefined,
      fixAvailable: values["fix-available"] === true,
      kev: values.kev === true,
      plugin: str("plugin"),
      search: str("search"),
      includeDismissed: values["include-dismissed"] === true,
      service: str("service"),
    },
    jit: {
      policy: str("policy"),
      role: str("role"),
      scope: str("scope"),
      duration: str("for"),
      by: str("by"),
      ticket: str("ticket"),
      note: str("note"),
      status: str("status"),
      mine: values.mine === true,
      holding: values.holding === true,
    },
    leaks: {
      status: str("status"),
      comment: str("comment"),
      valueStdin: values["value-stdin"] === true,
      keepUpstreamOpen: values["keep-upstream-open"] === true,
    },
    positionals: parsed.positionals,
    version: values.version === true,
    tier: boundedInt("tier", 1, 4),
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
    throw new CliError(`Invalid --last "${text}": use forms like 7d, 30d, 12w, 3m`, 2);
  }
  const n = Number(match[1]);
  return n * { d: 1, w: 7, m: 30 }[match[2] as "d" | "w" | "m"]!;
}

const DURATION_RE = /^(\d+)([mhdw])$/;

/** Parse `--last 90m|6h|7d|2w` into milliseconds. */
export function parseDuration(text: string): number {
  const match = DURATION_RE.exec(text);
  if (!match) {
    throw new CliError(`Invalid duration "${text}": use forms like 30m, 6h, 7d, 2w`, 2);
  }
  const n = Number(match[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[match[2]!]!;
  return n * unit;
}
