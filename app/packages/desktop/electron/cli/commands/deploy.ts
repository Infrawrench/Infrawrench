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
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// The runtime is ESM-only (its package exports raw .ts), so this CommonJS
// module takes types statically (erased) and the values via dynamic import —
// the same split electron/workflow-host.ts uses.
import type {
  BuildRequest,
  InfrafileCreatedResource,
  InfrafileGitContext,
  InfrafileHost,
  InfrafilePlannedChange,
  MetricValue,
  PromptSpec,
  ResourceInstanceLite,
  RunInImageRequest,
  RunLogEntry,
  SidecarRef,
  WorkflowHost,
  WorkflowPluginInfo,
} from "@infrawrench/workflow-runtime" with { "resolution-mode": "import" };
import type { PluginClient, ResourceTypeDefinition } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};

import { buildLocally, pushLocally, runInImage } from "../../infrafile/build-local";
import { recordLocalDeploy, readLocalDeploys, type LocalDeployRun } from "../../deploy-history";
import { createLocalPluginClient } from "../../infrafile/plugin-host";
import {
  CliError,
  listCloudAccounts,
  listLocalAccounts,
  listOrgs,
  orgFetch,
  resolveOrg,
  type AccountInfo,
  type CliContext,
  type OrgInfo,
} from "../context";
import { createOrgClient } from "../org-plugin-client";
import { createCliPeerClient } from "../peer-client";
import type { DeployFlags } from "../args";
import { c, printErr, printJson, printTable, println } from "../output";
import { askText, confirm, selectOne } from "../prompt";

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

/** The merged accounts tree plus the routing table `getClient` needs. */
interface DeployPluginTree {
  plugins: WorkflowPluginInfo[];
  /** Org account ids → where their client lives. Empty for `--local` runs. */
  orgAccounts: Map<string, { orgId: string; pluginId: string }>;
}

/**
 * The org whose accounts the Infrafile sees, per the CLI's global scope flags:
 * `--local` → none, `--org` → that org (errors propagate — the user named it),
 * no flag → the default org, degrading to local-only when the cloud is not
 * reachable. A deploy must never fail because the org could not be listed.
 */
async function resolveDeployOrg(
  ctx: CliContext,
): Promise<{ org: OrgInfo; accounts: AccountInfo[] } | null> {
  if (ctx.flags.local) return null;
  try {
    const org = await resolveOrg(ctx);
    return { org, accounts: await listCloudAccounts(org.id) };
  } catch (e) {
    if (ctx.flags.org) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    printErr(c.dim(`org accounts unavailable (${msg}) — using local accounts only`));
    return null;
  }
}

/**
 * Build the accounts tree from the local database plus the scoped org. Mirrors
 * the renderer's `listLocalPlugins`, but only needs enough for
 * `infra.accounts.<plugin>` to resolve — create-field enrichment is a
 * typings-path concern and would hit provider APIs on every deploy.
 *
 * Resource-type metadata always comes from the locally loaded plugin
 * definitions — the same code the server runs — so a plugin with only org
 * accounts (gcp connected in the cloud, nothing local) still gets its full
 * `resourceTypes`. The org rows only contribute accounts.
 */
async function listPluginTree(ctx: CliContext): Promise<DeployPluginTree> {
  const orgAccountRoutes = new Map<string, { orgId: string; pluginId: string }>();
  const [localAccounts, cloud] = await Promise.all([listLocalAccounts(), resolveDeployOrg(ctx)]);
  const cloudAccounts = cloud?.accounts ?? [];
  if (localAccounts.length === 0 && cloudAccounts.length === 0) {
    return { plugins: [], orgAccounts: orgAccountRoutes };
  }
  const { loadPlugins } = await import("../../infrafile/plugins.js");
  const loaded = await loadPlugins();

  const addOrgAccounts = (
    orgMine: AccountInfo[],
    localNames: Set<string>,
  ): WorkflowPluginInfo["accounts"] =>
    orgMine.map((a) => {
      orgAccountRoutes.set(a.id, { orgId: cloud!.org.id, pluginId: a.pluginId });
      return {
        id: a.id,
        pluginId: a.pluginId,
        // A name that collides with a local account's would make two select()
        // options read identically; the org's name disambiguates.
        displayName: localNames.has(a.displayName)
          ? `${a.displayName} (${cloud!.org.displayName})`
          : a.displayName,
      };
    });

  const tree: WorkflowPluginInfo[] = [];
  const knownPluginIds = new Set<string>();
  for (const { plugin } of loaded) {
    knownPluginIds.add(plugin.manifest.id);
    const localMine = localAccounts.filter((a) => a.pluginId === plugin.manifest.id);
    const orgMine = cloudAccounts.filter((a) => a.pluginId === plugin.manifest.id);
    if (localMine.length === 0 && orgMine.length === 0) continue;
    tree.push({
      pluginId: plugin.manifest.id,
      displayName: plugin.manifest.displayName,
      accounts: [
        ...localMine.map((a) => ({ id: a.id, pluginId: a.pluginId, displayName: a.displayName })),
        ...addOrgAccounts(orgMine, new Set(localMine.map((a) => a.displayName))),
      ],
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

  // Org accounts whose plugin this build does not carry still resolve as
  // accounts; identity comes from the org's plugin metadata (GET
  // /accounts/plugins), and with no local type definitions the resourceTypes
  // stay empty.
  // Peer plugins each resource type exposes (a cluster's `kubernetes`, a
  // managed database's `postgres`). Functional, not typings garnish: the
  // prelude builds `cluster.kubernetes` — including its resource groups and
  // importYaml — from exactly this, so without it sidecars are undefined
  // inside the sandbox.
  const { attachSidecarInfo } = await import("@infrawrench/workflow-runtime");
  const { getPlugin } = await import("../../infrafile/plugins.js");
  await Promise.all(
    tree.map((entry) => {
      const lp = loaded.find(({ plugin }) => plugin.manifest.id === entry.pluginId);
      if (!lp) return Promise.resolve();
      return attachSidecarInfo(
        entry.resourceTypes,
        lp.plugin.resourceTypes,
        async (id) => (await getPlugin(id))?.plugin,
      );
    }),
  );

  const orphans = cloudAccounts.filter((a) => !knownPluginIds.has(a.pluginId));
  if (orphans.length > 0 && cloud) {
    let names = new Map<string, string>();
    try {
      const plugins = await orgFetch<Array<{ id: string; displayName: string }>>(
        cloud.org.id,
        "/accounts/plugins",
      );
      names = new Map(plugins.map((p) => [p.id, p.displayName]));
    } catch {
      // Identity falls back to the plugin id.
    }
    const byPlugin = new Map<string, AccountInfo[]>();
    for (const a of orphans) byPlugin.set(a.pluginId, [...(byPlugin.get(a.pluginId) ?? []), a]);
    for (const [pluginId, mine] of byPlugin) {
      tree.push({
        pluginId,
        displayName: names.get(pluginId) ?? pluginId,
        accounts: addOrgAccounts(mine, new Set()),
        resourceTypes: [],
      });
    }
  }
  return { plugins: tree, orgAccounts: orgAccountRoutes };
}

/**
 * A live plugin client for one locally-stored account, found by id. The
 * plugin id rides along because a sidecar resolution needs to know which
 * plugin's resource types declare the peer integration.
 */
async function resolveLocalClient(
  accountId: string,
): Promise<{ client: PluginClient; pluginId: string }> {
  const accounts = await listLocalAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Account "${accountId}" not found.`);
  return {
    client: await createLocalPluginClient(accountId, account.pluginId),
    pluginId: account.pluginId,
  };
}

/**
 * The workflow host wired to this machine's accounts plus the scoped org's.
 * `prompt` is the only part that differs per caller: a deploy answers
 * `select(...)` at the terminal, while the ledger commands (`status`,
 * `destroy --created`) have nothing to ask and pass one that throws.
 *
 * The tree is assembled up front — `getClient` routes by account id, and the
 * ledger commands call `listResources`/`deleteResource` with recorded ids
 * without ever going through `listPlugins`.
 */
async function buildCliWorkflowHost(
  ctx: CliContext,
  prompt: (spec: PromptSpec) => Promise<MetricValue>,
  tree?: DeployPluginTree,
): Promise<WorkflowHost> {
  const { buildWorkflowHost } = await import("@infrawrench/workflow-runtime");
  const { plugins, orgAccounts } = tree ?? (await listPluginTree(ctx));
  return buildWorkflowHost({
    listPlugins: async () => plugins,
    getClient: async (accountId: string, sidecar?: SidecarRef) => {
      // The parent client resolves the same way with or without a sidecar:
      // local accounts run the plugin off decrypted local credentials, org
      // accounts off credentials fetched over the org API (with the REST
      // fallback inside `createOrgClient`).
      const route = orgAccounts.get(accountId);
      const parent = route
        ? {
            client: await createOrgClient(route.orgId, accountId, route.pluginId),
            pluginId: route.pluginId,
          }
        : await resolveLocalClient(accountId);
      if (!sidecar) return parent.client;
      // A sidecar ref asks for the PEER plugin a parent resource exposes
      // (kubernetes inside a managed cluster, postgres inside a managed
      // database): resolve its credentials through the parent's outputs and
      // build the peer plugin's client right here.
      return createCliPeerClient(parent.client, accountId, parent.pluginId, sidecar);
    },
    getMetric: async () => null,
    setMetric: async () => {},
    listMetrics: async () => ({}),
    // Storage reads need the plugin's StorageNodeDriver wired up; a deploy has
    // no use for them today, so fail clearly rather than returning empty bytes.
    readStorageObject: async () => {
      throw new CliError("Reading storage objects is not supported from the CLI.", 2);
    },
    prompt,
  });
}

/**
 * Ask, BEFORE the isolate starts, whose cloud accounts this run sees: one of
 * the operator's organizations (merged with the local workspace) or the local
 * workspace alone. Deciding it up front means `infra.accounts` is settled by
 * the time `plan()` first reads it — which accounts exist is scope, not
 * something a plan should discover mid-run.
 *
 * Only asks when there is genuinely a question: an interactive terminal, no
 * `--org`/`--local` already saying the answer, and at least one org to offer.
 * The choice lands in `ctx.flags`, so everything downstream — the accounts
 * tree, run recording, plan diffs — follows the same scope.
 */
async function chooseDeployScope(ctx: CliContext, json: boolean): Promise<void> {
  if (ctx.flags.org || ctx.flags.local || json || process.stdin.isTTY !== true) return;
  let orgs: OrgInfo[];
  try {
    orgs = await listOrgs();
  } catch {
    return; // Not signed in — the tree builder already degrades to local.
  }
  if (orgs.length === 0) return;
  const LOCAL_ONLY = "__local__";
  const chosen = await selectOne("Accounts scope", [
    ...orgs.map((o) => ({ label: `local + ${o.displayName}`, value: o.id })),
    { label: "local workspace only", value: LOCAL_ONLY },
  ]);
  if (chosen === LOCAL_ONLY) ctx.flags.local = true;
  else ctx.flags.org = chosen;
}

/**
 * Write the ambient declarations for an Infrafile to stdout, so an editor can
 * type it. Generated from the caller's own accounts, exactly like a workflow's
 * — `infra.accounts.` autocompletes with real account names.
 *
 * Deliberately plain stdout with no decoration: this is meant to be redirected
 * into `Infrafile.d.ts`.
 */
async function cmdDeployTypings(ctx: CliContext): Promise<void> {
  const { generateInfrafileDts } = await import("@infrawrench/workflow-runtime");
  const { plugins } = await listPluginTree(ctx);

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

/**
 * `infrawrench deploy log` — deploy history, newest first.
 *
 * `--local` reads this machine's own runs (the same list the desktop app's
 * Deploy tab shows in local mode); anything else reads the organization's.
 */
async function cmdDeployLog(ctx: CliContext, flags: DeployFlags): Promise<void> {
  if (ctx.flags.local) {
    cmdDeployLogLocal(ctx, flags);
    return;
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

/** The `--local` half of `deploy log`: runs built by this machine's Docker. */
function cmdDeployLogLocal(ctx: CliContext, flags: DeployFlags): void {
  const runs = readLocalDeploys().filter((r) => !flags.env || r.env === flags.env);

  if (ctx.flags.output === "json") {
    printJson(runs);
    return;
  }
  if (runs.length === 0) {
    println(c.dim("No local deploys yet. Run `infrawrench deploy` in a project directory."));
    return;
  }
  printTable(runs, [
    {
      header: "when",
      value: (r) => new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " "),
    },
    { header: "env", value: (r) => r.env || "—" },
    {
      header: "commit",
      value: (r) => (r.gitSha ? `${r.gitSha.slice(0, 7)}${r.dirty ? "*" : ""}` : "—"),
    },
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
    { header: "where", value: (r) => r.dir },
  ]);
  if (runs.some((r) => r.dirty)) {
    println("");
    println(c.dim("* built from a working tree with uncommitted changes"));
  }
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
    result: {
      status: string;
      image?: string;
      env: string;
      notes?: string[];
      error?: { message: string };
    };
  }>(org.id, `/deployments/runs/${encodeURIComponent(target)}/rollback`, {
    method: "POST",
    ...(flags.deleteCreated ? { body: JSON.stringify({ deleteCreated: true }) } : {}),
  });

  if (ctx.flags.output === "json") {
    printJson(result);
  } else if (result.status === "success") {
    println(
      `${c.green("✓")} rolled back to ${c.bold(result.image ?? "")} on ${c.bold(result.env)}`,
    );
    // With --delete-created the notes carry what was (and wasn't) undone.
    if (flags.deleteCreated) {
      for (const note of result.notes ?? []) {
        if (note.startsWith("deleted ")) println(`${c.green("✓")} ${note}`);
        else if (note.startsWith("could not delete ")) println(`${c.yellow("!")} ${note}`);
      }
    }
  }
  if (result.status !== "success") {
    throw new CliError(result.error?.message ?? "Rollback failed.", 1);
  }
}

/** Print the writes a `--plan` run intercepted, terraform-style. */
function printPlannedChanges(changes: InfrafilePlannedChange[]): void {
  println(c.bold("Planned changes"));
  if (changes.length === 0) {
    println(c.dim("No resource changes."));
    return;
  }
  let creates = 0;
  let updates = 0;
  let deletes = 0;
  for (const change of changes) {
    const line = `${change.resourceTypeId} ${change.displayName}`;
    if (change.action === "create") {
      creates += 1;
      println(`${c.green("+")} ${line}`);
    } else if (change.action === "update") {
      updates += 1;
      println(`${c.yellow("~")} ${line}`);
    } else {
      deletes += 1;
      println(`${c.red("-")} ${line}`);
    }
  }
  println(c.dim(`${creates} to create, ${updates} to update, ${deletes} to delete`));
}

/**
 * A plan key whose value must never be echoed. Whole camel/snake words, so
 * `gcpKeyB64` and `registry` redact while ordinary keys print.
 */
function isSensitivePlanKey(name: string): boolean {
  if (/password|secret|token|credential|registry|key$/i.test(name)) return true;
  return /Key(?=[A-Z0-9]|$)/.test(name) || /(?:^|[_.-])key(?:[_.-]|$)/i.test(name);
}

/** JSON for a diff line: one line, at most 60 characters. */
function shortJson(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The plan the env's last successful deploy recorded, or undefined. */
async function fetchPreviousPlan(ctx: CliContext, env: string): Promise<unknown> {
  if (ctx.flags.local) {
    const previous = readLocalDeploys().find(
      (r) => r.env === env && r.status === "success" && r.plan !== undefined && r.plan !== null,
    );
    return previous?.plan;
  }
  const org = await resolveOrg(ctx);
  const rows = await orgFetch<DeploymentRunRow[]>(
    org.id,
    `/deployments/runs?env=${encodeURIComponent(env)}`,
  );
  const last = rows.find((r) => r.status === "success");
  if (!last) return undefined;
  const row = await orgFetch<{ planJson?: unknown }>(
    org.id,
    `/deployments/runs/${encodeURIComponent(last.id)}`,
  );
  return row.planJson ?? undefined;
}

/**
 * Shallow-diff this plan against the previous successful deploy's. Best-effort
 * by contract: the plan itself is already on the screen, so nothing thrown in
 * here may escape — a diff that cannot be computed simply does not appear.
 */
async function printPlanDiff(ctx: CliContext, env: string, plan: unknown): Promise<void> {
  try {
    const previousPlan = await fetchPreviousPlan(ctx, env);
    if (previousPlan === undefined) {
      println(c.dim("No previous deploy to diff against."));
      return;
    }
    const before = asPlainObject(previousPlan);
    const after = asPlainObject(plan);
    const lines: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const show = (value: unknown): string =>
        isSensitivePlanKey(key) ? "(redacted)" : shortJson(value);
      if (!(key in before)) {
        lines.push(`${c.green("+")} ${key}: ${show(after[key])}`);
      } else if (!(key in after)) {
        lines.push(`${c.red("-")} ${key}`);
      } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        lines.push(`${c.yellow("~")} ${key}: ${show(before[key])} → ${show(after[key])}`);
      }
    }
    if (lines.length === 0) {
      println(c.dim("No changes since last deploy."));
      return;
    }
    println("Changes since last deploy:");
    for (const line of lines) println(line);
  } catch {
    // Offline, signed out, or a server without plan storage — the plan is
    // printed either way, the diff just goes missing.
  }
}

/**
 * Record a run. Two destinations, and they are not alternatives:
 *
 * - The org, so a terminal deploy and a web deploy share one history. Skipped
 *   for `--local`, and best-effort otherwise: a deploy that worked must not be
 *   reported as failed because the record afterwards did not land.
 * - This machine, always — including `--local`, which has no org to report to.
 *   That is what the desktop app's Deploy tab reads when no org is selected.
 */
async function recordRun(
  ctx: CliContext,
  result: {
    env: string;
    status: string;
    image?: string;
    reachedStage?: string;
    notes: string[];
    createdResources?: InfrafileCreatedResource[];
    output?: unknown;
    plan?: unknown;
    durationMs: number;
    error?: { message: string };
  },
  git: InfrafileGitContext,
  dir: string,
  startedAt: number,
): Promise<void> {
  let orgId: string | null = null;
  if (!ctx.flags.local) {
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
          createdResources: result.createdResources ?? [],
          // JSON.stringify drops these when the run declared neither.
          output: result.output,
          plan: result.plan,
          durationMs: result.durationMs,
          error: result.error ? { message: result.error.message } : null,
        }),
      });
      orgId = org.id;
    } catch {
      // Not signed in, offline, or no permission — the deploy still happened,
      // and the local record below still captures it.
    }
  }

  const local: LocalDeployRun = {
    id: randomUUID(),
    startedAt: new Date(startedAt).toISOString(),
    env: result.env,
    repo: git.repo ?? null,
    branch: git.branch || null,
    gitSha: git.sha || null,
    dirty: git.dirty === true,
    image: result.image ?? null,
    status: isDeployStatus(result.status) ? result.status : "failure",
    stage: result.reachedStage ?? null,
    durationMs: result.durationMs,
    dir,
    notes: result.notes,
    createdResources: result.createdResources ?? [],
    error: result.error?.message ?? null,
    orgId,
    ...(result.plan !== undefined ? { plan: result.plan } : {}),
    ...(result.output !== undefined ? { output: result.output } : {}),
  };
  recordLocalDeploy(local);
}

function isDeployStatus(status: string): status is LocalDeployRun["status"] {
  return ["success", "failure", "canceled", "running", "pending"].includes(status);
}

/**
 * `infrawrench deploy outputs` — what the last successful deploy's
 * `infra.output({...})` declared. The org's record for cloud-visible runs,
 * this machine's for `--local`.
 */
async function cmdDeployOutputs(ctx: CliContext, flags: DeployFlags): Promise<void> {
  let output: unknown;
  if (ctx.flags.local) {
    const successes = readLocalDeploys().filter(
      (r) => (!flags.env || r.env === flags.env) && r.status === "success",
    );
    if (successes.length === 0) throw new CliError("No successful deploy found.", 1);
    output = successes.find((r) => r.output !== undefined && r.output !== null)?.output;
  } else {
    const org = await resolveOrg(ctx);
    const query = flags.env ? `?env=${encodeURIComponent(flags.env)}` : "";
    const rows = await orgFetch<DeploymentRunRow[]>(org.id, `/deployments/runs${query}`);
    const last = rows.find((r) => r.status === "success");
    if (!last) throw new CliError("No successful deploy found.", 1);
    const row = await orgFetch<{ output?: unknown }>(
      org.id,
      `/deployments/runs/${encodeURIComponent(last.id)}`,
    );
    output = row.output;
  }

  if (ctx.flags.output === "json") {
    printJson(output ?? null);
    return;
  }
  if (output === undefined || output === null) {
    println(
      c.dim(
        "The last successful deploy recorded no output — call infra.output({...}) in deploy().",
      ),
    );
    return;
  }
  println(JSON.stringify(output, null, 2));
}

/** A ledger entry plus the env whose run created it. */
type LedgerResource = LocalDeployRun["createdResources"][number] & { env: string };

/**
 * Everything the local ledger says still exists: created resources across all
 * recorded runs (newest run first, and within a run in reverse creation order,
 * so children come before their parents), deduped to the newest record per
 * accountId:resourceTypeId:resourceId.
 */
function collectLedgerResources(env?: string | undefined): LedgerResource[] {
  const seen = new Set<string>();
  const out: LedgerResource[] = [];
  for (const run of readLocalDeploys()) {
    if (env && run.env !== env) continue;
    for (const res of [...(run.createdResources ?? [])].reverse()) {
      const key = `${res.accountId}:${res.resourceTypeId}:${res.resourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...res, env: run.env });
    }
  }
  return out;
}

/**
 * `infrawrench deploy status` — is what the ledger says was created still
 * there? Checked against the LOCAL deploy history on purpose: that is where
 * CLI-created resources are recorded, so it is the only ledger this machine
 * can vouch for. Each (account, type) pair is listed once via the providers.
 */
async function cmdDeployStatus(ctx: CliContext, flags: DeployFlags): Promise<void> {
  const json = ctx.flags.output === "json";
  const resources = collectLedgerResources(flags.env);
  if (resources.length === 0) {
    if (json) printJson([]);
    else println(c.dim("Nothing recorded — deploys that create resources will appear here."));
    return;
  }

  const host = await buildCliWorkflowHost(ctx, async () => {
    throw new CliError("deploy status never prompts.", 2);
  });

  // One listing per (account, type) pair; null marks a pair whose provider
  // call failed, so its resources report "unknown" rather than "missing".
  const listings = new Map<string, ResourceInstanceLite[] | null>();
  for (const res of resources) {
    if (res.sidecar) continue;
    const key = `${res.accountId} ${res.resourceTypeId}`;
    if (listings.has(key)) continue;
    try {
      listings.set(key, await host.listResources(res.accountId, res.resourceTypeId));
    } catch (e) {
      listings.set(key, null);
      const msg = e instanceof Error ? e.message : String(e);
      printErr(c.dim(`could not list ${res.resourceTypeId} on ${res.accountId}: ${msg}`));
    }
  }

  const stateOf = (res: LedgerResource): "ok" | "missing" | "unknown" => {
    // Listing through a sidecar needs the parent context — out of scope here.
    if (res.sidecar) return "unknown";
    const listed = listings.get(`${res.accountId} ${res.resourceTypeId}`);
    if (!listed) return "unknown";
    const found = listed.some(
      (r) =>
        r.id === res.resourceId ||
        (res.externalId !== undefined && r.externalId === res.externalId),
    );
    return found ? "ok" : "missing";
  };
  const states = resources.map((res) => ({ res, state: stateOf(res) }));

  if (json) {
    printJson(
      states.map(({ res, state }) => ({
        env: res.env,
        accountId: res.accountId,
        resourceTypeId: res.resourceTypeId,
        resourceId: res.resourceId,
        externalId: res.externalId ?? null,
        displayName: res.displayName,
        state,
      })),
    );
    return;
  }

  printTable(states, [
    { header: "type", value: ({ res }) => res.resourceTypeId },
    { header: "name", value: ({ res }) => res.displayName },
    { header: "account", value: ({ res }) => res.accountId },
    { header: "env", value: ({ res }) => res.env },
    {
      header: "state",
      value: ({ state }) =>
        state === "ok" ? c.green(state) : state === "missing" ? c.red(state) : c.dim(state),
    },
  ]);
  const count = (state: string): number => states.filter((s) => s.state === state).length;
  println("");
  println(c.dim(`${count("ok")} ok, ${count("missing")} missing, ${count("unknown")} unknown`));
}

/**
 * `infrawrench deploy destroy --created` — no Infrafile involved: delete what
 * the local ledger says this env's runs created, children before parents.
 */
async function cmdDeployDestroyCreated(ctx: CliContext, flags: DeployFlags): Promise<void> {
  const env = flags.env;
  if (!env) throw new CliError("Deleting by ledger needs an explicit --env.", 2);
  const json = ctx.flags.output === "json";

  if (!json && process.stdin.isTTY === true) {
    if (!(await confirm(`Delete every resource the local ledger says "${env}" created?`))) {
      throw new CliError("Aborted — nothing was deleted.", 1);
    }
  }

  const startedAt = Date.now();
  const resources = collectLedgerResources(env);
  if (resources.length === 0) {
    if (json) printJson({ env, deleted: 0, failed: 0, notes: [] });
    else println(c.dim("Nothing recorded — deploys that create resources will appear here."));
    return;
  }

  const host = await buildCliWorkflowHost(ctx, async () => {
    throw new CliError("deploy destroy --created never prompts.", 2);
  });
  const deleteResource = host.deleteResource;
  if (!deleteResource) throw new CliError("This host cannot delete resources.", 1);

  const notes: string[] = [];
  let deleted = 0;
  let failed = 0;
  for (const res of resources) {
    const label = `${res.resourceTypeId} ${res.displayName}`;
    try {
      await deleteResource(res.accountId, res.resourceTypeId, res.resourceId, res.sidecar);
      deleted += 1;
      notes.push(`deleted ${label}`);
      if (!json) println(`${c.green("✓")} deleted ${label}`);
    } catch (e) {
      failed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      notes.push(`could not delete ${label}: ${msg}`);
      if (!json) println(`${c.yellow("!")} could not delete ${label}: ${msg}`);
    }
  }

  if (json) {
    printJson({ env, deleted, failed, notes });
  } else {
    println("");
    println(`${deleted} deleted, ${failed} failed`);
  }

  const git = await gitContext(process.cwd());
  recordLocalDeploy({
    id: randomUUID(),
    startedAt: new Date(startedAt).toISOString(),
    env,
    repo: git.repo ?? null,
    branch: git.branch || null,
    gitSha: git.sha || null,
    dirty: git.dirty === true,
    image: null,
    status: "success",
    stage: "destroy",
    durationMs: Date.now() - startedAt,
    dir: process.cwd(),
    notes,
    createdResources: [],
    error: null,
    orgId: null,
  });
}

export async function cmdDeploy(ctx: CliContext, flags: DeployFlags): Promise<void> {
  const sub = ctx.positionals[1];
  if (sub === "typings") {
    await cmdDeployTypings(ctx);
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
  if (sub === "outputs") {
    await cmdDeployOutputs(ctx, flags);
    return;
  }
  if (sub === "status") {
    await cmdDeployStatus(ctx, flags);
    return;
  }

  // `deploy destroy` — run the Infrafile's destroy() stage: tear down what
  // deploy() created for this environment. Same host, same file discovery; the
  // runtime skips plan, dockerfile and build entirely.
  const destroy = sub === "destroy";
  if (destroy && flags.plan) {
    throw new CliError("--plan previews a deploy; destroy has no plan stage.", 2);
  }
  // `--created` needs no Infrafile at all: the ledger names what to delete.
  if (destroy && flags.created) {
    await cmdDeployDestroyCreated(ctx, flags);
    return;
  }

  const startedAt = Date.now();
  const { dir, file } = await findInfrafile(process.cwd());
  const source = await readFile(file, "utf8");
  const git = await gitContext(dir);
  const answers = parseAnswers(flags.set);

  const json = ctx.flags.output === "json";

  // Scope first: whose cloud accounts does this run see? Settled before the
  // sandbox starts (and before the ledger/plan lookups below, which follow the
  // same scope).
  await chooseDeployScope(ctx, json);

  // Tearing down is the one deploy-shaped action with nothing to preview, so a
  // person at a terminal gets asked once. Non-interactive runs (CI teardown of
  // a preview env) proceed — there is nobody to ask, and that is the use case.
  if (destroy && !json && process.stdin.isTTY === true) {
    const target = flags.env ? `"${flags.env}"` : "this project's environment";
    if (!(await confirm(`Tear down ${target}? This runs the Infrafile's destroy() stage.`))) {
      throw new CliError("Aborted — nothing was torn down.", 1);
    }
  }

  // destroy() never prompts, so anything env and git cannot name has to come
  // from state the deploy wrote down — hand it the env's last successful
  // deploy's recorded plan. Best-effort by contract: a teardown must not fail
  // because the org was unreachable; the stage just sees no plan.
  let destroyPlan: unknown;
  if (destroy) {
    try {
      // The plan lookup needs the env before the runtime resolves it; a file
      // declaring exactly one env is read the same way `deploy typings` does.
      let env = flags.env;
      if (!env) {
        const match = source.match(/envs\s*:\s*\[([^\]]*)\]/);
        const declared = match?.[1]
          ? [...match[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!)
          : [];
        if (declared.length === 1) env = declared[0];
      }
      if (env) destroyPlan = await fetchPreviousPlan(ctx, env);
    } catch {
      // No history reachable — destroy() runs with plan undefined.
    }
  }
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

  const tree = await listPluginTree(ctx);

  // Everything the run needs from this machine and the scoped org.
  // `buildWorkflowHost` would give us the full resource surface, but it wants
  // a client factory — which is exactly what the account-id routing in
  // `buildCliWorkflowHost` provides.
  const { runInfrafile } = await import("@infrawrench/workflow-runtime");
  const base = await buildCliWorkflowHost(
    ctx,
    async (spec: PromptSpec) => {
      const options = (spec.options ?? []).map((o) => ({
        label: o.label,
        value: o.value,
        ...(o.hint ? { hint: o.hint } : {}),
      }));
      if (options.length > 0) return selectOne(spec.message, options);
      if (spec.kind === "boolean") return confirm(spec.message);
      // Everything else is typed text. The runtime validates and coerces the
      // answer, so the terminal only has to collect the characters — a number
      // that isn't one is rejected there with the key named, not here.
      const hint =
        spec.kind === "date"
          ? `${spec.message} (YYYY-MM-DD)`
          : spec.kind === "number"
            ? `${spec.message} (number)`
            : spec.message;
      return askText(hint, spec.defaultValue ?? "");
    },
    tree,
  );

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

  const result = await runInfrafile({
    source,
    host,
    git,
    // A deploy legitimately waits on real infrastructure — provisioning a
    // managed cluster can take ten-plus minutes — so the runaway-code budget
    // gets an hour rather than the default five.
    limits: { timeoutMs: 60 * 60 * 1000 },
    // Undefined lets the runner pick when the file declares exactly one env,
    // and otherwise fail naming the ones it declares.
    ...(flags.env ? { env: flags.env } : {}),
    interactive: process.stdin.isTTY === true,
    planOnly: flags.plan,
    ...(destroy ? { destroy: true } : {}),
    ...(destroy && destroyPlan !== undefined ? { destroyPlan } : {}),
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
      plannedChanges: result.plannedChanges,
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
      printPlannedChanges(result.plannedChanges);
      println("");
      await printPlanDiff(ctx, result.env, result.plan);
      println("");
      println(c.dim("Nothing was built. Re-run without --plan to deploy."));
    } else if (destroy) {
      println(`${c.green("✓")} destroyed ${c.bold(result.env)}`);
    } else {
      println(`${c.green("✓")} deployed ${c.bold(result.image ?? "")} to ${c.bold(result.env)}`);
    }
  }

  // Record before throwing: a failed deploy is exactly the one worth having in
  // the history.
  if (!flags.plan) await recordRun(ctx, result, git, dir, startedAt);

  if (result.status !== "success") {
    let message = result.error?.message ?? "Deploy failed.";
    // The runtime's error already explains itself; the ledger path is the one
    // way out it cannot know about.
    if (destroy && message.includes("no destroy() stage")) {
      message +=
        " Or run `deploy destroy --created` to delete what the ledger says this env created.";
    }
    throw new CliError(message, 1);
  }
}
