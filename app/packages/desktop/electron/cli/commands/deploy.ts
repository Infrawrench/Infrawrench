/**
 * `infrawrench deploy` — build and ship the project in the current directory,
 * driven by the `Infrafile` at its repository root.
 *
 * The CLI is the local half of the feature: the Infrafile is read from disk
 * (never from a database), the image is built by the Docker daemon on this
 * machine, and `select(...)` is answered by a terminal prompt or by `--set`.
 * The web app does the same three stages against a repo pulled from git and an
 * SSH build host — same runtime, different edges.
 */
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// The runtime is ESM-only (its package exports raw .ts), so this CommonJS
// module takes types statically (erased) and the values via dynamic import —
// the same split electron/workflow-host.ts uses.
import type {
  BuildRequest,
  InfrafileGitContext,
  InfrafileHost,
  PromptSpec,
  RunInImageRequest,
  RunLogEntry,
  WorkflowPluginInfo,
} from "@infrawrench/workflow-runtime" with { "resolution-mode": "import" };
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};

import { buildLocally, pushLocally, runInImage } from "../../infrafile/build-local";
import { createLocalPluginClient } from "../../infrafile/plugin-host";
import { CliError, listLocalAccounts, orgFetch, resolveOrg, type CliContext } from "../context";
import type { DeployFlags } from "../args";
import { c, printJson, printTable, println } from "../output";
import { askText, selectOne } from "../prompt";

const run = promisify(execFile);

/** Matches `INFRAFILE_NAME` in the runtime; duplicated to keep this module CJS. */
const INFRAFILE_NAME = "Infrafile";

/**
 * Walk up from `cwd` looking for an Infrafile.
 *
 * The search stops at the repository root — a directory containing `.git`. An
 * Infrafile lives at a repo root by definition, so climbing past one would pick
 * up an unrelated project's file and then build *its* directory as the context,
 * with this repo's git facts attached. Outside a repo there is no such boundary,
 * so the walk runs to the filesystem root.
 *
 * The directory holding the file is also the Docker build context; being the
 * same directory is what makes there be nothing to configure.
 */
async function findInfrafile(from: string): Promise<{ dir: string; file: string }> {
  const start = path.resolve(from);
  let dir = start;
  for (;;) {
    const file = path.join(dir, INFRAFILE_NAME);
    try {
      await access(file);
      return { dir, file };
    } catch {
      // Nothing here — but if this is the repo root, the search ends.
      let atRepoRoot = false;
      try {
        await access(path.join(dir, ".git"));
        atRepoRoot = true;
      } catch {
        // Not a repo root; keep climbing.
      }
      const parent = path.dirname(dir);
      if (atRepoRoot) {
        throw new CliError(
          `No ${INFRAFILE_NAME} at the root of this repository (${dir}).\n` +
            `An Infrafile lives beside your .git directory.`,
          2,
        );
      }
      if (parent === dir) {
        throw new CliError(`No ${INFRAFILE_NAME} found in ${start} or any parent directory.`, 2);
      }
      dir = parent;
    }
  }
}

/** Best-effort git facts. A directory that isn't a repo still deploys. */
async function gitContext(dir: string): Promise<InfrafileGitContext> {
  const git = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await run("git", args, { cwd: dir });
      return stdout.trim();
    } catch {
      return "";
    }
  };

  const [sha, branch, status, remote] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["status", "--porcelain"]),
    git(["config", "--get", "remote.origin.url"]),
  ]);

  // `owner/name` from either an SSH or HTTPS remote.
  const match = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);

  const ctx: InfrafileGitContext = {
    sha: sha || "0000000000000000000000000000000000000000",
    branch: branch || "HEAD",
  };
  if (match?.[1]) ctx.repo = match[1];
  if (status) ctx.dirty = true;
  return ctx;
}

/** Parse `--set key=value` pairs into the answers a non-interactive run needs. */
function parseAnswers(pairs: string[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new CliError(`--set expects key=value, got ${JSON.stringify(pair)}.`, 2);
    }
    answers[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return answers;
}

/**
 * Build the accounts tree from the local database. Mirrors the renderer's
 * `listLocalPlugins`, but only needs enough for `infra.accounts.<plugin>` to
 * resolve — create-field enrichment is a typings-path concern and would hit
 * provider APIs on every deploy.
 */
async function listLocalPluginTree(): Promise<WorkflowPluginInfo[]> {
  const accounts = await listLocalAccounts();
  if (accounts.length === 0) return [];
  const { loadPlugins } = await import("../../infrafile/plugins.js");
  const loaded = await loadPlugins();

  const tree: WorkflowPluginInfo[] = [];
  for (const { plugin } of loaded) {
    const mine = accounts.filter((a) => a.pluginId === plugin.manifest.id);
    if (mine.length === 0) continue;
    tree.push({
      pluginId: plugin.manifest.id,
      displayName: plugin.manifest.displayName,
      accounts: mine.map((a) => ({
        id: a.id,
        pluginId: a.pluginId,
        displayName: a.displayName,
      })),
      resourceTypes: plugin.resourceTypes.map((rt: ResourceTypeDefinition) => ({
        id: rt.id,
        displayName: rt.displayName,
        pluralDisplayName: rt.pluralDisplayName,
        outputs: (rt.outputs ?? []).map((o: { key: string; label: string }) => ({
          key: o.key,
          label: o.label,
        })),
        supportsCreate: Boolean(rt.supportsCreate),
        supportsUpdate: Boolean(rt.supportsUpdate),
        supportsDelete: rt.supportsDelete !== false,
      })),
    });
  }
  return tree;
}

/**
 * Write the ambient declarations for an Infrafile to stdout, so an editor can
 * type it. Generated from the caller's own accounts, exactly like a workflow's
 * — `infra.accounts.` autocompletes with real account names.
 *
 * Deliberately plain stdout with no decoration: this is meant to be redirected
 * into `Infrafile.d.ts`.
 */
async function cmdDeployTypings(): Promise<void> {
  const { generateInfrafileDts } = await import("@infrawrench/workflow-runtime");
  const plugins = await listLocalPluginTree();

  // Best-effort: the envs narrow the `InfraEnv` union, and an Infrafile that
  // isn't there yet (or doesn't parse) simply gets the open `string` type.
  let envs: string[] = [];
  try {
    const { file } = await findInfrafile(process.cwd());
    const match = (await readFile(file, "utf8")).match(/envs\s*:\s*\[([^\]]*)\]/);
    if (match?.[1]) {
      envs = [...match[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
    }
  } catch {
    // No Infrafile yet — typings still help you write the first one.
  }

  process.stdout.write(generateInfrafileDts({ plugins, envs }));
}

interface DeploymentRunRow {
  id: string;
  env: string;
  repo: string | null;
  gitSha: string | null;
  image: string | null;
  status: string;
  origin: string;
  durationMs: number | null;
  startedAt: string;
}

/** `infrawrench deploy log` — the org's deploy history, newest first. */
async function cmdDeployLog(ctx: CliContext, flags: DeployFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Deploy history lives in Infrawrench Cloud — pass --org instead.", 2);
  }
  const org = await resolveOrg(ctx);
  const query = flags.env ? `?env=${encodeURIComponent(flags.env)}` : "";
  const rows = await orgFetch<DeploymentRunRow[]>(org.id, `/deployments/runs${query}`);

  if (ctx.flags.output === "json") {
    printJson(rows);
    return;
  }
  printTable(rows, [
    {
      header: "when",
      value: (r) => new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " "),
    },
    { header: "env", value: (r) => r.env || "—" },
    { header: "commit", value: (r) => (r.gitSha ? r.gitSha.slice(0, 7) : "—") },
    { header: "image", value: (r) => r.image ?? "—" },
    {
      header: "status",
      value: (r) =>
        r.status === "success"
          ? c.green(r.status)
          : r.status === "failure"
            ? c.red(r.status)
            : r.status,
    },
    {
      header: "took",
      value: (r) => (r.durationMs === null ? "—" : `${Math.round(r.durationMs / 1000)}s`),
      align: "right",
    },
    { header: "from", value: (r) => r.origin },
  ]);
}

/**
 * `infrawrench deploy rollback` — ship a previous run's artifact again.
 *
 * The rollback itself happens server-side: it re-reads the Infrafile at the
 * commit that run deployed and replays its `deploy()` with the recorded image,
 * so nothing is rebuilt and the local working tree is irrelevant.
 */
async function cmdDeployRollback(ctx: CliContext, flags: DeployFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Rollback needs the cloud deploy history — pass --org instead.", 2);
  }
  const org = await resolveOrg(ctx);

  let target = flags.toRun;
  if (!target) {
    // Default to the last success for the env, which is what "roll back" means
    // when nobody names a run.
    const query = flags.env ? `?env=${encodeURIComponent(flags.env)}` : "";
    const rows = await orgFetch<DeploymentRunRow[]>(org.id, `/deployments/runs${query}`);
    const candidates = rows.filter((r) => r.status === "success" && r.image);
    // [0] is the deploy currently live, so [1] is the one to go back to.
    const previous = candidates[1];
    if (!previous) {
      throw new CliError(
        "No earlier successful deploy to roll back to. Pass --to-run <runId> to choose one.",
        2,
      );
    }
    target = previous.id;
    if (ctx.flags.output !== "json") {
      println(`${c.dim("rolling back to")} ${previous.image} ${c.dim(`(${previous.id})`)}`);
    }
  }

  const { result } = await orgFetch<{
    runId: string;
    result: { status: string; image?: string; env: string; error?: { message: string } };
  }>(org.id, `/deployments/runs/${encodeURIComponent(target)}/rollback`, { method: "POST" });

  if (ctx.flags.output === "json") {
    printJson(result);
  } else if (result.status === "success") {
    println(
      `${c.green("✓")} rolled back to ${c.bold(result.image ?? "")} on ${c.bold(result.env)}`,
    );
  }
  if (result.status !== "success") {
    throw new CliError(result.error?.message ?? "Rollback failed.", 1);
  }
}

/**
 * Report a local run to the org so both origins share one history. Best-effort:
 * a deploy that worked must not be reported as failed because the record
 * afterwards did not land.
 */
async function recordRun(
  ctx: CliContext,
  result: {
    env: string;
    status: string;
    image?: string;
    reachedStage?: string;
    notes: string[];
    durationMs: number;
    error?: { message: string };
  },
  git: InfrafileGitContext,
): Promise<void> {
  if (ctx.flags.local) return;
  try {
    const org = await resolveOrg(ctx);
    await orgFetch(org.id, "/deployments/runs", {
      method: "POST",
      body: JSON.stringify({
        env: result.env,
        status: result.status,
        repo: git.repo,
        branch: git.branch,
        gitSha: git.sha,
        image: result.image,
        stage: result.reachedStage,
        notes: result.notes,
        durationMs: result.durationMs,
        error: result.error ? { message: result.error.message } : null,
      }),
    });
  } catch {
    // Not signed in, offline, or no permission — the deploy still happened.
  }
}

export async function cmdDeploy(ctx: CliContext, flags: DeployFlags): Promise<void> {
  const sub = ctx.positionals[1];
  if (sub === "typings") {
    await cmdDeployTypings();
    return;
  }
  if (sub === "log") {
    await cmdDeployLog(ctx, flags);
    return;
  }
  if (sub === "rollback") {
    await cmdDeployRollback(ctx, flags);
    return;
  }

  const { dir, file } = await findInfrafile(process.cwd());
  const source = await readFile(file, "utf8");
  const git = await gitContext(dir);
  const answers = parseAnswers(flags.set);

  const json = ctx.flags.output === "json";
  // Build output goes to the terminal as it arrives, but is also captured: in
  // --json mode nothing is printed, and a failed CI run needs the docker output
  // to be diagnosable rather than just an exit code and a message.
  const buildLogs: RunLogEntry[] = [];
  const emit = (line: string): void => {
    buildLogs.push({ at: Date.now(), level: "info", message: line });
    if (!json) println(line);
  };

  if (!json) {
    const shown = path.relative(process.cwd(), file) || INFRAFILE_NAME;
    println(c.bold(shown === INFRAFILE_NAME ? INFRAFILE_NAME : shown));
    println(
      `${c.dim("commit")}  ${git.sha.slice(0, 7)} ${c.dim(`(${git.branch})`)}${
        git.dirty ? ` ${c.yellow("· uncommitted changes")}` : ""
      }`,
    );
    println("");
  }

  // Everything the run needs from this machine. `buildWorkflowHost` would give
  // us the full resource surface, but it wants a client factory — which is
  // exactly what `createLocalPluginClient` is.
  const { buildWorkflowHost, runInfrafile } = await import("@infrawrench/workflow-runtime");
  const base = buildWorkflowHost({
    listPlugins: listLocalPluginTree,
    getClient: (accountId: string) => resolveClient(accountId),
    getMetric: async () => null,
    setMetric: async () => {},
    listMetrics: async () => ({}),
    // Storage reads need the plugin's StorageNodeDriver wired up; a deploy has
    // no use for them today, so fail clearly rather than returning empty bytes.
    readStorageObject: async () => {
      throw new CliError("Reading storage objects is not supported from the CLI.", 2);
    },
    prompt: async (spec: PromptSpec) => {
      const options = (spec.options ?? []).map((o) => ({ label: o.label, value: o.value }));
      if (options.length > 0) return selectOne(spec.message, options);
      return askText(spec.message, spec.defaultValue ?? "");
    },
  });

  const host: InfrafileHost = {
    ...base,
    infrafileAnswer: async (key: string) => answers[key],
    infrafileBuild: (request: BuildRequest) => {
      if (request.target && request.target.kind !== "local") {
        throw new CliError(
          `plan().buildOn points at ${request.target.resource.displayName ?? request.target.resource.id}, ` +
            "but building on a remote host is only available from the web app. " +
            'Use "local" to build here.',
          2,
        );
      }
      return buildLocally(request, {
        contextDir: dir,
        log: emit,
        // Same image name a web deploy of this repo would produce.
        ...(git.repo ? { projectName: git.repo } : {}),
        gitSha: git.sha,
      });
    },
    infrafilePush: (image, registry) => pushLocally(image, registry, { log: emit }),
    infrafileRun: (request) => runInImage(request, { contextDir: dir, log: emit }),
    infrafileCopyTo: async () => {
      throw new CliError(
        "copyTo() needs the SSH transfer path, which is only available from the web app today.",
        2,
      );
    },
  };

  async function resolveClient(accountId: string) {
    const accounts = await listLocalAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`Account "${accountId}" not found.`);
    return createLocalPluginClient(accountId, account.pluginId);
  }

  const result = await runInfrafile({
    source,
    host,
    git,
    // Undefined lets the runner pick when the file declares exactly one env,
    // and otherwise fail naming the ones it declares.
    ...(flags.env ? { env: flags.env } : {}),
    interactive: process.stdin.isTTY === true,
    planOnly: flags.plan,
    onLog: (entry) => {
      if (!json) println(entry.level === "error" ? c.red(entry.message) : entry.message);
    },
    onStage: (stage) => {
      if (!json) println(c.dim(`— ${stage} —`));
    },
  });

  if (json) {
    printJson({
      status: result.status,
      env: result.env,
      plan: result.plan,
      dockerfile: result.dockerfile,
      image: result.image,
      notes: result.notes,
      // Text mode streams these to the terminal as they arrive; JSON mode
      // suppresses that, so without them here a failed CI run reports a message
      // and no build output to work out why.
      // Interleave by timestamp: the run's own entries (notes, stage markers)
      // and the build driver's output are two streams of one story.
      logs: [...result.logs, ...buildLogs].sort((a, b) => a.at - b.at),
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error.message } : {}),
    });
  } else if (result.status === "success") {
    println("");
    if (flags.plan) {
      println(c.bold("Plan"));
      println(JSON.stringify(result.plan, null, 2));
      println("");
      println(c.bold("Dockerfile"));
      println(result.dockerfile ?? "");
      println("");
      println(c.dim("Nothing was built. Re-run without --plan to deploy."));
    } else {
      println(`${c.green("✓")} deployed ${c.bold(result.image ?? "")} to ${c.bold(result.env)}`);
    }
  }

  // Record before throwing: a failed deploy is exactly the one worth having in
  // the history.
  if (!flags.plan) await recordRun(ctx, result, git);

  if (result.status !== "success") {
    throw new CliError(result.error?.message ?? "Deploy failed.", 1);
  }
}
