// `infrawrench pr-check`: the pull request check, before (or without) a pull
// request. Two forms:
//
//   infrawrench pr-check [--base <ref>] [--repo owner/name]
//     analyses the local working tree against the merge base with <ref>
//     (default: the remote's default branch), uncommitted edits included;
//   infrawrench pr-check --repo owner/name --pr <n>
//     analyses an open pull request through the org's GitHub App.
//
// Either way nothing is posted: this is `POST /pr-checks/preview`, the same
// analysis the github-watcher posts as a check run, so the numbers here are
// the numbers the pull request will show. Cloud-only (pricing runs on the
// server's plugin clients, blast radius on the org's synced graph).
//
// Zero new dependencies: git is run with node:child_process, and only the
// file kinds the check reads are sent (Terraform, Infrafiles and YAML that
// looks like a Kubernetes manifest), at most 50 of them.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  PrCheckPreview,
  PrCheckPreviewFile,
  PrCheckRepository,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };

import type { PrCheckFlags } from "../args";
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import { githubRepoFromRemote, parseNameStatusZ } from "../format";
import { c, printJson, println, printTable, type Column } from "../output";

const run = promisify(execFile);

/** Mirrors `PR_CHECK_LIMITS` (the CLI imports client-core types only). */
const MAX_FILES = 50;
const MAX_FILE_BYTES = 512 * 1024;

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new CliError(`git ${args[0]} failed: ${message}`);
  }
}

function isInfraPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return base.endsWith(".tf") || base === "Infrafile" || /\.ya?ml$/i.test(base);
}

async function defaultBase(): Promise<string> {
  const head = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => "");
  const ref = head.trim().replace(/^refs\/remotes\//, "");
  return ref || "origin/main";
}

async function localFiles(base: string, root: string): Promise<PrCheckPreviewFile[]> {
  const mergeBase = (await git(["merge-base", base, "HEAD"])).trim();
  const entries = parseNameStatusZ(
    await git(["diff", "--name-status", "-M", "-z", mergeBase, "--"]),
  ).filter((e) => isInfraPath(e.path));
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((p) => p.length > 0 && isInfraPath(p))
    .map((path) => ({ status: "A" as const, path, previousPath: null }));

  const files: PrCheckPreviewFile[] = [];
  for (const e of [...entries, ...untracked].slice(0, MAX_FILES)) {
    const before =
      e.status === "A"
        ? null
        : await git(["show", `${mergeBase}:${e.previousPath ?? e.path}`]).catch(() => null);
    const after =
      e.status === "D" ? null : await readFile(`${root}/${e.path}`, "utf8").catch(() => null);
    if (before === null && after === null) continue;
    if ((before?.length ?? 0) > MAX_FILE_BYTES || (after?.length ?? 0) > MAX_FILE_BYTES) {
      println(c.yellow(`skipping ${e.path}: larger than ${MAX_FILE_BYTES / 1024} KiB`));
      continue;
    }
    files.push({ path: e.path, before, after });
  }
  return files;
}

export async function cmdPrCheck(ctx: CliContext, flags: PrCheckFlags): Promise<void> {
  const org = await resolveOrg(ctx);
  let preview: PrCheckPreview;
  let label: string;

  if (flags.pr !== undefined) {
    if (!flags.repo) throw new CliError("--pr needs --repo owner/name.");
    const repos = await orgFetch<PrCheckRepository[]>(org.id, "/pr-checks/repositories");
    const repository = repos.find((r) => r.repo.toLowerCase() === flags.repo!.toLowerCase());
    if (!repository) {
      throw new CliError(
        `${flags.repo} has no pull request checks configured. Turn them on in Settings → Pull Request Checks.`,
      );
    }
    label = `${repository.repo}#${flags.pr}`;
    preview = await orgFetch<PrCheckPreview>(org.id, "/pr-checks/preview", {
      method: "POST",
      body: JSON.stringify({ repositoryId: repository.id, pullNumber: flags.pr }),
    });
  } else {
    const root = (await git(["rev-parse", "--show-toplevel"])).trim();
    const base = flags.base ?? (await defaultBase());
    const repo =
      flags.repo ??
      githubRepoFromRemote(await git(["remote", "get-url", "origin"]).catch(() => "")) ??
      undefined;
    const files = await localFiles(base, root);
    label = `working tree vs ${base}`;
    if (files.length === 0) {
      if (ctx.flags.output === "json") {
        printJson({ org: org.id, base, files: 0, preview: null });
      } else {
        println(c.dim(`No infrastructure files differ from ${base}.`));
      }
      return;
    }
    preview = await orgFetch<PrCheckPreview>(org.id, "/pr-checks/preview", {
      method: "POST",
      body: JSON.stringify({ files, ...(repo ? { repo } : {}) }),
    });
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, target: label, ...preview });
    return;
  }

  const conclusion =
    preview.conclusion === "failure"
      ? c.red("failure")
      : preview.conclusion === "neutral"
        ? c.yellow("neutral")
        : c.green("success");
  println(`${c.bold(label)} ${c.dim("·")} ${conclusion} ${c.dim("·")} ${preview.title}`);
  const { report } = preview;
  if (report.changes.length > 0) {
    println();
    const money = (s: { monthlyAmount: number; currency: string } | null) =>
      s ? `${s.currency} ${s.monthlyAmount.toFixed(2)}` : c.dim("-");
    const columns: Column<(typeof report.changes)[number]>[] = [
      { header: "resource", value: (ch) => ch.address },
      { header: "action", value: (ch) => ch.action },
      { header: "before", value: (ch) => money(ch.before), align: "right" },
      { header: "after", value: (ch) => money(ch.after), align: "right" },
      {
        header: "monthly",
        value: (ch) =>
          ch.monthlyDelta !== null && ch.currency
            ? `${ch.monthlyDelta > 0 ? "+" : ""}${ch.monthlyDelta.toFixed(2)}`
            : c.dim("not priced"),
        align: "right",
      },
      {
        header: "blast radius",
        value: (ch) =>
          ch.blastRadius
            ? `${ch.blastRadius.severity} (${ch.blastRadius.directDependants + ch.blastRadius.transitiveDependants})`
            : c.dim(ch.action === "create" ? "new" : ch.resourceId ? "unknown" : "not matched"),
      },
    ];
    printTable(report.changes, columns);
  }
  const warnings = report.changes.flatMap((ch) =>
    ch.warnings.map(
      (w) => `${w.severity === "warning" ? c.yellow("!") : c.dim("i")} ${ch.address}: ${w.message}`,
    ),
  );
  if (warnings.length > 0) {
    println();
    for (const w of warnings) println(w);
  }
  const unpriced = report.changes.filter((ch) => ch.unpricedReason);
  if (unpriced.length > 0) {
    println();
    println(c.bold("not priced"));
    for (const ch of unpriced) println(`  ${ch.address}: ${c.dim(ch.unpricedReason ?? "")}`);
  }
  const skipped = report.files.filter((f) => !f.analysed);
  for (const f of skipped) println(c.dim(`${f.path}: ${f.note ?? "not analysed"}`));
  if (report.notes.length > 0) {
    println();
    for (const n of report.notes) println(c.dim(n));
  }
}
