// `infrawrench ssh-fanout <command>`: run one command across many SSH hosts
// and collapse the per-host output so the odd one out stands out.
//
// Cloud only: the fan-out runner lives server-side (POST /ssh-fanout/run),
// which is where the change-freeze gate, the org keystore, and the audit trail
// are. `infrawrench ssh-fanout --list` shows the selectable hosts, and
// `ssh-fanout snippets` lists the org's saved commands.
//
// Grouping and diffing come from @infrawrench/client-core (the same functions
// the web and desktop screens render) so the CLI can never disagree with the
// UI about which host is the outlier. Pulled in through the workspace package
// the CLI already depends on: no new runtime dependency.
//
// `--json` shapes:
//   ssh-fanout snippets      → { org, snippets }
//   ssh-fanout --list        → { org, targets }            (the selected ones)
//   ssh-fanout <command>     → { org, command, results }
import { Effect, Option, Schema, Stdio } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { FanoutHostResult, FanoutHostStatus } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { confirm } from "../effect/prompt";
import { positiveInt } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { decodePaired, knownOr, Unrecognized, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });
const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

/**
 * Mirrors `FANOUT_MAX_TARGETS` in client-core. Duplicated as a literal because
 * the CLI is CommonJS and client-core is ESM-only: the shared module is
 * reached through `await import()` where values are actually needed, and a
 * top-level constant is not worth an async hop just to render an error.
 */
const MAX_TARGETS = 100;

const SNIPPETS_PATH = "/ssh-fanout/snippets";
const TARGETS_PATH = "/ssh-fanout/targets";
const RUN_PATH = "/ssh-fanout/run";
const KEYS_PATH = "/ssh-keys";

const Target = Schema.Struct({
  // Sent back to the server as it came: the server checks it.
  kind: Schema.String,
  id: Schema.String,
  label: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  running: Schema.Boolean,
  needsKey: Schema.Boolean,
  tags: Schema.Array(Schema.String),
});
type Target = typeof Target.Type;
const TargetsEnvelope = Schema.Struct({ targets: Schema.Unknown });

const Snippet = Schema.Struct({ name: Schema.String, command: Schema.String });
type Snippet = typeof Snippet.Type;
const Snippets = Schema.Struct({ snippets: Schema.Array(Snippet) });
const SnippetsEnvelope = Schema.Struct({ snippets: Schema.Unknown });

const SshKeys = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));

const HostResult = Schema.Struct({
  targetId: Schema.String,
  label: Schema.String,
  status: knownOr(["pending", "running", "done", "error", "blocked"]),
  exitCode: Schema.NullOr(Schema.Finite),
  stdout: Schema.String,
  stderr: Schema.String,
  error: Schema.optionalKey(Schema.String),
});
const RunResults = wire<{ results: FanoutHostResult[] }>()(
  Schema.Struct({ results: Schema.Array(HostResult) }),
);
const RunEnvelope = Schema.Struct({ results: Schema.Unknown });

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliUsageError({
      message:
        "Fan-out SSH runs server-side (change freezes, the org keystore and the audit trail live there). Drop --local, or use the desktop app's Fan-out screen for local SSH accounts.",
    });
  }
});

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** `ssh-fanout snippets`: the org's saved commands. */
const snippets = Command.make(
  "snippets",
  {},
  Effect.fn("ssh-fanout.snippets")(function* () {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, SNIPPETS_PATH);
    if (session.output === "json") {
      const { snippets: raw } = yield* decodeBody(SnippetsEnvelope, SNIPPETS_PATH)(body);
      return yield* Print.json({ org: org.id, snippets: raw });
    }
    const { snippets: rows } = yield* decodeBody(Snippets, SNIPPETS_PATH)(body);
    if (rows.length === 0) {
      return yield* Print.line(
        c.dim("No saved snippets. Save one from the Fan-out screen in the app."),
      );
    }
    const columns: Column<Snippet>[] = [
      { header: "NAME", value: (s) => safe(s.name) },
      { header: "COMMAND", value: (s) => safe(firstLine(s.command)) },
    ];
    yield* Print.table(rows, columns);
  }),
).pipe(Command.withDescription("The organization's saved fan-out commands"));

interface TargetFilter {
  readonly hosts: string | undefined;
  readonly plugin: string | undefined;
  readonly tag: string | undefined;
}

function matchesFilter(t: Target, filter: TargetFilter): boolean {
  const q = filter.hosts?.trim().toLowerCase();
  if (filter.plugin && t.pluginId !== filter.plugin) return false;
  if (filter.tag && !t.tags.includes(filter.tag)) return false;
  if (!q) return true;
  return (
    t.label.toLowerCase().includes(q) ||
    (t.host ?? "").toLowerCase().includes(q) ||
    t.tags.some((tag) => tag.toLowerCase().includes(q))
  );
}

/** Accept an SSH key by id or by display name, like the workflow SSH host does. */
const resolveSshKeyId = Effect.fnUntraced(function* (orgId: string, wanted: string) {
  const api = yield* CloudApi;
  const keys = yield* api.decode(SshKeys, orgId, KEYS_PATH);
  const match = keys.find((k) => k.id === wanted) ?? keys.find((k) => k.name === wanted);
  if (!match) {
    const names = keys.map((k) => k.name).join(", ");
    return yield* new CliUsageError({
      message: `No SSH key "${wanted}" in this organization.${names ? ` Available: ${names}` : ""}`,
    });
  }
  return match.id;
});

/**
 * `groupFanoutResults` decides failure by status: a status this build does
 * not know is not a success it can vouch for, so it groups as an error.
 */
const UNKNOWN_STATUS: FanoutHostStatus = "error";

/** Text rendering: one block per distinct output, outliers diffed. */
const printGroupedResults = Effect.fnUntraced(function* (
  decoded: ReadonlyArray<typeof HostResult.Type>,
) {
  // Grouping/diffing is the same code the app's Fan-out screen renders, so the
  // CLI can never disagree about which host is the outlier.
  const { groupFanoutResults, diffLines, compactDiff } = yield* loadCore;
  const results: FanoutHostResult[] = decoded.map((r) => ({
    ...r,
    status: r.status instanceof Unrecognized ? UNKNOWN_STATUS : r.status,
  }));
  const groups = groupFanoutResults(results);
  const majority = groups.find((g) => g.isMajority);
  const ok = results.filter((r) => r.status === "done" && (r.exitCode ?? 0) === 0).length;

  yield* Print.line("");
  yield* Print.line(
    `${results.length} host${results.length === 1 ? "" : "s"} · ${c.green(`${ok} ok`)} · ` +
      `${results.length - ok > 0 ? c.red(`${results.length - ok} failed`) : c.dim("0 failed")} · ` +
      `${groups.length} distinct output${groups.length === 1 ? "" : "s"}`,
  );

  for (const group of groups) {
    yield* Print.line("");
    const tag = group.isFailure
      ? c.red("failed")
      : group.isMajority
        ? c.cyan(group.results.length === results.length ? "all hosts" : "majority")
        : c.yellow("outlier");
    const exit = group.isFailure ? "" : c.dim(` exit ${group.exitCode ?? 0}`);
    yield* Print.line(
      `${tag} ${c.bold(`${group.results.length} host${group.results.length === 1 ? "" : "s"}`)}${exit}`,
    );
    yield* Print.line(c.dim(`  ${group.results.map((r) => safe(r.label)).join(", ")}`));

    // The lines below are the remote command's own output, printed as an
    // ssh session would print them.
    if (group.isFailure || group.isMajority || !majority) {
      for (const line of (group.output || "(no output)").split("\n")) {
        yield* Print.line(`  ${group.isFailure ? c.red(line) : line}`);
      }
      continue;
    }
    // Outlier: show how it differs from the majority rather than repeating
    // output the reader has already seen.
    for (const line of compactDiff(diffLines(majority.output, group.output))) {
      if ("skipped" in line) {
        yield* Print.line(
          c.dim(`  ⋯ ${line.skipped} unchanged line${line.skipped === 1 ? "" : "s"} ⋯`),
        );
      } else if (line.type === "added") {
        yield* Print.line(c.green(`  + ${line.line}`));
      } else if (line.type === "removed") {
        yield* Print.line(c.red(`  - ${line.line}`));
      } else {
        yield* Print.line(c.dim(`    ${line.line}`));
      }
    }
  }
});

export const sshFanout = Command.make(
  "ssh-fanout",
  {
    command: Argument.String("command").pipe(
      Argument.withDescription(
        "The command to run (put -- before one with flags of its own: ssh-fanout -y -- uptime -p)",
      ),
      Argument.variadic(),
    ),
    list: Flag.Boolean("list").pipe(
      Flag.withDescription("Show the selectable hosts instead of running"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    hosts: Flag.String("hosts").pipe(
      Flag.withMetavar("q"),
      Flag.withDescription("Match host name, address or tag"),
      Flag.optional,
    ),
    plugin: Flag.String("plugin").pipe(
      Flag.withMetavar("id"),
      Flag.withDescription("Restrict to one provider"),
      Flag.optional,
    ),
    tag: Flag.String("tag").pipe(
      Flag.withMetavar("key:value"),
      Flag.withDescription("Restrict to hosts carrying this tag"),
      Flag.optional,
    ),
    key: Flag.String("key").pipe(
      Flag.withMetavar("id|name"),
      Flag.withDescription("Org SSH key for VM hosts"),
      Flag.optional,
    ),
    user: Flag.String("user").pipe(
      Flag.withMetavar("name"),
      Flag.withDescription("Username override for VM hosts"),
      Flag.optional,
    ),
    snippet: Flag.String("snippet").pipe(
      Flag.withMetavar("name"),
      Flag.withDescription("Run a saved command instead of a literal one"),
      Flag.optional,
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription('Skip the "Run on N hosts?" confirmation'),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    concurrency: positiveInt("concurrency").pipe(
      Flag.withMetavar("n"),
      Flag.withDescription("Simultaneous connections (default 8, max 16)"),
      Flag.optional,
    ),
  },
  Effect.fn("ssh-fanout")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const json = session.output === "json";

    const targetsBody = yield* api.json(org.id, TARGETS_PATH);
    const { targets: rawTargets } = yield* decodeBody(TargetsEnvelope, TARGETS_PATH)(targetsBody);
    const filter: TargetFilter = {
      hosts: Option.getOrUndefined(input.hosts),
      plugin: Option.getOrUndefined(input.plugin),
      tag: Option.getOrUndefined(input.tag),
    };
    const selected = (yield* decodePaired(Schema.Array(Target), TARGETS_PATH)(rawTargets)).filter(
      ({ row }) => matchesFilter(row, filter),
    );

    if (input.list) {
      if (json) {
        return yield* Print.json({ org: org.id, targets: selected.map(({ raw }) => raw) });
      }
      if (selected.length === 0) return yield* Print.line(c.dim("No SSH-capable hosts match."));
      const columns: Column<Target>[] = [
        { header: "HOST", value: (t) => safe(t.label) },
        { header: "PLUGIN", value: (t) => safe(t.pluginId) },
        { header: "TYPE", value: (t) => safe(t.resourceTypeId ?? "ssh account") },
        { header: "ADDRESS", value: (t) => (t.host ? safe(t.host) : c.dim("(account)")) },
        { header: "STATE", value: (t) => (t.running ? c.green("running") : c.dim("stopped")) },
      ];
      return yield* Print.table(
        selected.map(({ row }) => row),
        columns,
      );
    }

    // The command is everything after the subcommand, or a saved snippet.
    let command = input.command.join(" ").trim();
    const snippetName = Option.getOrUndefined(input.snippet);
    if (snippetName) {
      const { snippets: saved } = yield* api.decode(Snippets, org.id, SNIPPETS_PATH);
      const match = saved.find((s) => s.name === snippetName);
      if (!match) {
        return yield* new CliUsageError({
          message: `No saved snippet named "${snippetName}". Run \`infrawrench ssh-fanout snippets\` to list them.`,
        });
      }
      command = match.command;
    }
    if (!command) {
      return yield* new CliUsageError({
        message:
          'Nothing to run. Pass a command (infrawrench ssh-fanout "uname -r"), --snippet <name>, or --list. ' +
          "If the remote command has flags of its own, put -- before it so they are not parsed here: " +
          "infrawrench ssh-fanout -y -- uptime -p.",
      });
    }

    const runnable = selected.map(({ row }) => row).filter((t) => t.running);
    if (runnable.length === 0) {
      return yield* new CliUsageError({
        message:
          "No running hosts match. Use --list to see what is selectable, and --hosts/--plugin/--tag to filter.",
      });
    }
    if (runnable.length > MAX_TARGETS) {
      return yield* new CliUsageError({
        message: `${runnable.length} hosts match. The server accepts at most ${MAX_TARGETS} per run. Narrow with --hosts/--plugin/--tag.`,
      });
    }

    let sshKeyId: string | undefined;
    if (runnable.some((t) => t.needsKey)) {
      const key = Option.getOrUndefined(input.key);
      if (!key) {
        return yield* new CliUsageError({
          message:
            "Some selected hosts are VMs that need one of your org SSH keys. Pass --key <id|name>.",
        });
      }
      sshKeyId = yield* resolveSshKeyId(org.id, key);
    }

    // Confirm step: always name the host count, matching the app's
    // "Run on N hosts?" gate. --yes skips it.
    if (!input.yes) {
      const hosts = `${runnable.length} host${runnable.length === 1 ? "" : "s"}`;
      yield* Print.line(`${c.bold(safe(command))}`);
      yield* Print.line(
        c.dim(
          `  on ${hosts}: ` +
            runnable
              .slice(0, 6)
              .map((t) => safe(t.label))
              .join(", ") +
            (runnable.length > 6 ? `, and ${runnable.length - 6} more` : ""),
        ),
      );
      const stdio = yield* Stdio.Stdio;
      if (!(yield* stdio.stdinIsTerminal)) {
        return yield* new CliUsageError({
          message:
            "Refusing to fan out without confirmation on a non-interactive terminal. Pass --yes to run unattended.",
        });
      }
      if (!(yield* confirm(`Run on ${hosts}?`))) return yield* Print.line(c.dim("Canceled."));
    }

    const user = Option.getOrUndefined(input.user);
    const concurrency = Option.getOrUndefined(input.concurrency);
    const runBody = yield* api.json(org.id, RUN_PATH, {
      method: "POST",
      body: JSON.stringify({
        command,
        targets: runnable.map((t) => ({ kind: t.kind, id: t.id })),
        ...(sshKeyId ? { sshKeyId } : {}),
        ...(user ? { username: user } : {}),
        ...(concurrency ? { concurrency } : {}),
      }),
    });

    if (json) {
      const { results } = yield* decodeBody(RunEnvelope, RUN_PATH)(runBody);
      return yield* Print.json({ org: org.id, command, results });
    }
    const { results } = yield* decodeBody(RunResults, RUN_PATH)(runBody);
    yield* printGroupedResults(results);
  }),
).pipe(
  Command.withDescription(
    "Run one command across many SSH hosts; identical output is collapsed and outliers are diffed against the majority",
  ),
  Command.withSubcommands([snippets]),
);
