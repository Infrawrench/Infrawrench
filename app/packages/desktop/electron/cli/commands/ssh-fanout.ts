// `infrawrench ssh-fanout <command>` — run one command across many SSH hosts
// and collapse the per-host output so the odd one out stands out.
//
// Cloud only: the fan-out runner lives server-side (POST /ssh-fanout/run),
// which is where the change-freeze gate, the org keystore, and the audit trail
// are. `infrawrench ssh-fanout --list` shows the selectable hosts, and
// `ssh-fanout snippets` lists the org's saved commands.
//
// Grouping and diffing come from @infrawrench/client-core — the same functions
// the web and desktop screens render — so the CLI can never disagree with the
// UI about which host is the outlier. Pulled in through the workspace package
// the CLI already depends on: no new runtime dependency.
import type { FanoutHostResult } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { orgFetch, resolveOrg, CliError, type CliContext } from "../context";
import type { FanoutFlags } from "../args";
import { confirm } from "../prompt";
import { c, printJson, println, printTable, type Column } from "../output";

/**
 * Mirrors `FANOUT_MAX_TARGETS` in client-core. Duplicated as a literal because
 * the CLI is CommonJS and client-core is ESM-only — the shared module is
 * reached through `await import()` where values are actually needed, and a
 * top-level constant is not worth an async hop just to render an error.
 */
const MAX_TARGETS = 100;

interface FanoutTarget {
  kind: "account" | "resource";
  id: string;
  label: string;
  pluginId: string;
  resourceTypeId?: string;
  host?: string;
  running: boolean;
  needsKey: boolean;
  tags: string[];
}

interface SnippetRow {
  id: string;
  name: string;
  command: string;
  description: string | null;
}

export async function cmdSshFanout(
  ctx: CliContext,
  rest: string[],
  flags: FanoutFlags,
): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Fan-out SSH runs server-side (change freezes, the org keystore and the audit trail live there). Drop --local, or use the desktop app's Fan-out screen for local SSH accounts.",
      2,
    );
  }
  const org = await resolveOrg(ctx);

  if (rest[0] === "snippets") {
    const { snippets } = await orgFetch<{ snippets: SnippetRow[] }>(org.id, "/ssh-fanout/snippets");
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, snippets });
      return;
    }
    if (snippets.length === 0) {
      println(c.dim("No saved snippets. Save one from the Fan-out screen in the app."));
      return;
    }
    const columns: Column<SnippetRow>[] = [
      { header: "NAME", value: (s) => s.name },
      { header: "COMMAND", value: (s) => firstLine(s.command) },
    ];
    printTable(snippets, columns);
    return;
  }

  const { targets } = await orgFetch<{ targets: FanoutTarget[] }>(org.id, "/ssh-fanout/targets");
  const selected = filterTargets(targets, flags);

  if (flags.list) {
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, targets: selected });
      return;
    }
    if (selected.length === 0) {
      println(c.dim("No SSH-capable hosts match."));
      return;
    }
    const columns: Column<FanoutTarget>[] = [
      { header: "HOST", value: (t) => t.label },
      { header: "PLUGIN", value: (t) => t.pluginId },
      { header: "TYPE", value: (t) => t.resourceTypeId ?? "ssh account" },
      { header: "ADDRESS", value: (t) => t.host ?? c.dim("(account)") },
      { header: "STATE", value: (t) => (t.running ? c.green("running") : c.dim("stopped")) },
    ];
    printTable(selected, columns);
    return;
  }

  // The command is everything after the subcommand, or a saved snippet.
  let command = rest.join(" ").trim();
  if (flags.snippet) {
    const { snippets } = await orgFetch<{ snippets: SnippetRow[] }>(org.id, "/ssh-fanout/snippets");
    const match = snippets.find((s) => s.name === flags.snippet);
    if (!match) {
      throw new CliError(
        `No saved snippet named "${flags.snippet}". Run \`infrawrench ssh-fanout snippets\` to list them.`,
        2,
      );
    }
    command = match.command;
  }
  if (!command) {
    throw new CliError(
      'Nothing to run. Pass a command (infrawrench ssh-fanout "uname -r"), --snippet <name>, or --list. ' +
        "If the remote command has flags of its own, put -- before it so they are not parsed here: " +
        "infrawrench ssh-fanout -y -- uptime -p.",
      2,
    );
  }

  const runnable = selected.filter((t) => t.running);
  if (runnable.length === 0) {
    throw new CliError(
      "No running hosts match. Use --list to see what is selectable, and --hosts/--plugin/--tag to filter.",
      2,
    );
  }
  if (runnable.length > MAX_TARGETS) {
    throw new CliError(
      `${runnable.length} hosts match — the server accepts at most ${MAX_TARGETS} per run. Narrow with --hosts/--plugin/--tag.`,
      2,
    );
  }

  const needsKey = runnable.some((t) => t.needsKey);
  let sshKeyId: string | undefined;
  if (needsKey) {
    if (!flags.key) {
      throw new CliError(
        "Some selected hosts are VMs that need one of your org SSH keys — pass --key <id|name>.",
        2,
      );
    }
    sshKeyId = await resolveSshKeyId(org.id, flags.key);
  }

  // Confirm step: always name the host count, matching the app's
  // "Run on N hosts?" gate. --yes (or a non-TTY with --yes) skips it.
  if (!flags.yes) {
    println(`${c.bold(command)}`);
    println(
      c.dim(
        `  on ${runnable.length} host${runnable.length === 1 ? "" : "s"}: ` +
          runnable
            .slice(0, 6)
            .map((t) => t.label)
            .join(", ") +
          (runnable.length > 6 ? `, and ${runnable.length - 6} more` : ""),
      ),
    );
    if (!process.stdin.isTTY) {
      throw new CliError(
        "Refusing to fan out without confirmation on a non-interactive terminal. Pass --yes to run unattended.",
        2,
      );
    }
    const ok = await confirm(`Run on ${runnable.length} host${runnable.length === 1 ? "" : "s"}?`);
    if (!ok) {
      println(c.dim("Canceled."));
      return;
    }
  }

  const { results } = await orgFetch<{ results: FanoutHostResult[] }>(org.id, "/ssh-fanout/run", {
    method: "POST",
    body: JSON.stringify({
      command,
      targets: runnable.map((t) => ({ kind: t.kind, id: t.id })),
      ...(sshKeyId ? { sshKeyId } : {}),
      ...(flags.user ? { username: flags.user } : {}),
      ...(flags.concurrency ? { concurrency: flags.concurrency } : {}),
    }),
  });

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, command, results });
    return;
  }

  await printGroupedResults(results);
}

/** Text rendering: one block per distinct output, outliers diffed. */
async function printGroupedResults(results: FanoutHostResult[]): Promise<void> {
  // Grouping/diffing is the same code the app's Fan-out screen renders, so the
  // CLI can never disagree about which host is the outlier. Reached through a
  // dynamic import because client-core is ESM and the CLI compiles to CJS.
  const { groupFanoutResults, diffLines, compactDiff } = await import("@infrawrench/client-core");
  const groups = groupFanoutResults(results);
  const majority = groups.find((g) => g.isMajority);
  const ok = results.filter((r) => r.status === "done" && (r.exitCode ?? 0) === 0).length;

  println("");
  println(
    `${results.length} host${results.length === 1 ? "" : "s"} · ${c.green(`${ok} ok`)} · ` +
      `${results.length - ok > 0 ? c.red(`${results.length - ok} failed`) : c.dim("0 failed")} · ` +
      `${groups.length} distinct output${groups.length === 1 ? "" : "s"}`,
  );

  for (const group of groups) {
    println("");
    const tag = group.isFailure
      ? c.red("failed")
      : group.isMajority
        ? c.cyan(group.results.length === results.length ? "all hosts" : "majority")
        : c.yellow("outlier");
    const exit = group.isFailure ? "" : c.dim(` exit ${group.exitCode ?? 0}`);
    println(
      `${tag} ${c.bold(`${group.results.length} host${group.results.length === 1 ? "" : "s"}`)}${exit}`,
    );
    println(c.dim(`  ${group.results.map((r) => r.label).join(", ")}`));

    if (group.isFailure || group.isMajority || !majority) {
      for (const line of (group.output || "(no output)").split("\n")) {
        println(`  ${group.isFailure ? c.red(line) : line}`);
      }
      continue;
    }
    // Outlier: show how it differs from the majority rather than repeating
    // output the reader has already seen.
    for (const line of compactDiff(diffLines(majority.output, group.output))) {
      if ("skipped" in line) {
        println(c.dim(`  ⋯ ${line.skipped} unchanged line${line.skipped === 1 ? "" : "s"} ⋯`));
      } else if (line.type === "added") {
        println(c.green(`  + ${line.line}`));
      } else if (line.type === "removed") {
        println(c.red(`  - ${line.line}`));
      } else {
        println(c.dim(`    ${line.line}`));
      }
    }
  }
}

function filterTargets(targets: FanoutTarget[], flags: FanoutFlags): FanoutTarget[] {
  const q = flags.hosts?.trim().toLowerCase();
  return targets.filter((t) => {
    if (flags.plugin && t.pluginId !== flags.plugin) return false;
    if (flags.tag && !t.tags.includes(flags.tag)) return false;
    if (!q) return true;
    return (
      t.label.toLowerCase().includes(q) ||
      (t.host ?? "").toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  });
}

/** Accept an SSH key by id or by display name, like the workflow SSH host does. */
async function resolveSshKeyId(orgId: string, wanted: string): Promise<string> {
  const keys = await orgFetch<Array<{ id: string; name: string }>>(orgId, "/ssh-keys");
  const match = keys.find((k) => k.id === wanted) ?? keys.find((k) => k.name === wanted);
  if (!match) {
    const names = keys.map((k) => k.name).join(", ");
    throw new CliError(
      `No SSH key "${wanted}" in this organization.${names ? ` Available: ${names}` : ""}`,
      2,
    );
  }
  return match.id;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
