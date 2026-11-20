/**
 * The command line: `infraenv <command> [flags]`, flags before or after the
 * command, `--flag value` or `--flag=value`. Node's own `parseArgs` does the
 * tokenising (no dependency, nothing to load); this module says which flags
 * each command takes and turns a misplaced one into a usage error.
 */
import { parseArgs } from "node:util";
import { UsageError } from "./io";

type Kind = "boolean" | "string" | "list";

interface FlagSpec {
  readonly kind: Kind;
  readonly short?: string;
}

const FLAGS = {
  help: { kind: "boolean", short: "h" },
  version: { kind: "boolean", short: "v" },
  json: { kind: "boolean" },
  "no-color": { kind: "boolean" },
  org: { kind: "string" },
  env: { kind: "string", short: "e" },
  file: { kind: "string", short: "f" },
  out: { kind: "string" },
  var: { kind: "list" },
  stdout: { kind: "boolean" },
  force: { kind: "boolean" },
  quiet: { kind: "boolean", short: "q" },
  "key-stdin": { kind: "boolean" },
} as const satisfies Record<string, FlagSpec>;

export type FlagName = keyof typeof FLAGS;

/** Accepted by every command. */
const GLOBAL: readonly FlagName[] = ["help", "version", "no-color"];

/** The commands and the flags each takes beyond the global ones. */
export const COMMANDS = {
  pull: ["env", "file", "out", "var", "stdout", "force", "quiet", "json", "org"],
  check: ["file", "var", "json", "org"],
  install: ["file", "json"],
  uninstall: ["json"],
  status: ["json"],
  login: ["key-stdin", "org"],
  logout: [],
  whoami: ["json"],
  skill: ["json"],
  help: [],
} as const satisfies Record<string, readonly FlagName[]>;

export type CommandName = keyof typeof COMMANDS;

export interface ParsedArgs {
  /** Null for a bare `infraenv`, `--help` or `--version`. */
  readonly command: CommandName | null;
  /** Positionals after the command (`help <command>`, `skill install`). */
  readonly rest: readonly string[];
  readonly help: boolean;
  readonly version: boolean;
  readonly noColor: boolean;
  readonly json: boolean;
  readonly org: string | null;
  readonly env: string | null;
  readonly file: string | null;
  readonly out: string | null;
  readonly vars: Readonly<Record<string, string>>;
  readonly stdout: boolean;
  readonly force: boolean;
  readonly quiet: boolean;
  readonly keyStdin: boolean;
  /** The flags as typed, for handing a command on to `infrawrench env`. */
  readonly given: ReadonlySet<FlagName>;
}

const isCommand = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);

/** `KEY=value` pairs from `--var`, the last one of a key winning. */
export function parseVars(pairs: readonly string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const key = at < 0 ? "" : pair.slice(0, at).trim();
    if (key === "") {
      throw new UsageError(`--var takes name=value, not ${JSON.stringify(pair)}`);
    }
    vars[key] = pair.slice(at + 1);
  }
  return vars;
}

export function parseCommandLine(argv: readonly string[]): ParsedArgs {
  const options = Object.fromEntries(
    Object.entries(FLAGS).map(([name, spec]) => [
      name,
      {
        type: spec.kind === "boolean" ? ("boolean" as const) : ("string" as const),
        multiple: spec.kind === "list",
        ...("short" in spec ? { short: spec.short } : {}),
      },
    ]),
  );
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Node's wording, minus the hint aimed at script authors.
    throw new UsageError(message.replace(/\.? ?To specify a positional argument.*$/s, ""));
  }
  const values = parsed.values as Record<string, string | boolean | string[] | undefined>;
  const [first, ...rest] = parsed.positionals;
  let command: CommandName | null = null;
  if (first !== undefined) {
    if (!isCommand(first)) throw new UsageError(`Unknown command ${JSON.stringify(first)}`);
    command = first;
  }
  const takesOne = command === "help" || command === "skill";
  if (command !== null && rest.length > (takesOne ? 1 : 0)) {
    throw new UsageError(`Unexpected argument ${JSON.stringify(rest[takesOne ? 1 : 0])}`);
  }
  if (command === "skill" && rest.length === 1 && rest[0] !== "install") {
    throw new UsageError(
      `Unknown skill subcommand ${JSON.stringify(rest[0])}; try \`infraenv skill install\``,
    );
  }

  const given = new Set<FlagName>();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) given.add(name as FlagName);
  }
  if (command !== null) {
    const allowed = new Set<FlagName>([...GLOBAL, ...COMMANDS[command]]);
    for (const name of given) {
      if (!allowed.has(name)) {
        throw new UsageError(`infraenv ${command} does not take --${name}`);
      }
    }
  } else {
    for (const name of given) {
      if (!GLOBAL.includes(name)) {
        throw new UsageError(`--${name} needs a command, as in \`infraenv pull --${name}\``);
      }
    }
  }

  const str = (name: FlagName) => {
    const v = values[name];
    return typeof v === "string" ? v : null;
  };
  const bool = (name: FlagName) => values[name] === true;
  const list = values.var;
  return {
    command,
    rest,
    help: bool("help"),
    version: bool("version"),
    noColor: bool("no-color"),
    json: bool("json"),
    org: str("org"),
    env: str("env"),
    file: str("file"),
    out: str("out"),
    vars: parseVars(Array.isArray(list) ? list : []),
    stdout: bool("stdout"),
    force: bool("force"),
    quiet: bool("quiet"),
    keyStdin: bool("key-stdin"),
    given,
  };
}
