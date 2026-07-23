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

export interface ParsedCli {
  flags: CliFlags;
  range: RangeFlags;
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
