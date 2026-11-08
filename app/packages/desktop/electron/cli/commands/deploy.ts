/**
 * `infrawrench deploy`: build and ship the project in the current directory,
 * driven by the `Infrafile` at its repository root.
 *
 * The CLI is the local half of the feature: the Infrafile is read from disk
 * (never from a database), the image is built by the Docker daemon on this
 * machine, and `select(...)` is answered by a terminal prompt or by `--set`.
 * The web app does the same three stages against a repo pulled from git and an
 * SSH build host: same runtime, different edges.
 *
 * The workflow runtime is Promise code that calls back into this host (build,
 * prompt, account clients), so the handler hands those callbacks a runner
 * over its own services (`Effect.runPromiseWith`): a callback's cloud call or
 * prompt is an Effect like any other, with the typed error's sentence as the
 * rejection's message. Build and run output is printed from the callbacks as
 * it arrives.
 *
 * `--json` shapes:
 *   deploy [destroy]   → { status, env, plan, dockerfile, image, notes, plannedChanges, logs, durationMs, error? }
 *   deploy log         → the runs, as the server (or `--local`, this machine's history) has them
 *   deploy rollback    → the rollback's result
 *   deploy outputs     → the last successful deploy's `infra.output(...)` value, or null
 *   deploy status      → [{ env, accountId, resourceTypeId, resourceId, externalId, displayName, state }]
 *   deploy destroy --created → { env, deleted, failed, notes }
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type Context, Effect, Option, Schema, Stdio, type Terminal } from "effect";
import { Command, Flag } from "effect/cli";

// The runtime is ESM-only (its package exports raw .ts), so this CommonJS
// module takes types statically (erased) and the values via dynamic import:
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
  RunLogEntry,
  SidecarRef,
  WorkflowHost,
  WorkflowPluginInfo,
} from "@infrawrench/workflow-runtime" with { "resolution-mode": "import" };
import type { HostPluginClient, ResourceTypeDefinition } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};

import { buildLocally, pushLocally, runInImage } from "../../infrafile/build-local";
import { LocalDeployHistory, recordLocalDeploy, type LocalDeployRun } from "../../deploy-history";
import { createLocalPluginClient } from "../../infrafile/plugin-host";
import {
  CliError,
  cloudAccounts,
  cloudResources,
  listLocalAccounts,
  syncCloud,
  type AccountInfo,
} from "../context";
import { bestEffort, CloudApi, decodeBody, type OrgInfo } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { askText, confirm, selectOne } from "../effect/prompt";
import { CliSession } from "../effect/session";
import { createOrgClient, type OrgTransport } from "../org-plugin-client";
import { createCliPeerClient } from "../peer-client";
import { c, printErr, println, safe, type Column } from "../output";

const run = promisify(execFile);

/** Matches `INFRAFILE_NAME` in the runtime; duplicated to keep this module CJS. */
const INFRAFILE_NAME = "Infrafile";

const RUNS_PATH = "/deployments/runs";

/** The services the runtime's callbacks run their Effects with. */
type DeployServices = CloudApi | CliSession | Terminal.Terminal | Stdio.Stdio;

/** Runs an Effect from inside a runtime callback, with the handler's services. */
type Runner = <A, E>(effect: Effect.Effect<A, E, DeployServices>) => Promise<A>;

const makeRunner = Effect.gen(function* () {
  const services: Context.Context<DeployServices> = yield* Effect.context<DeployServices>();
  const runner: Runner = (effect) => Effect.runPromiseWith(services)(effect);
  return runner;
});

/**
 * Whose cloud accounts the run sees: the global `--org`/`--local` flags, or
 * what the person at the terminal picked before the run started.
 */
interface DeployScope {
  readonly org: string | null;
  readonly local: boolean;
}

const sessionScope = CliSession.use((session) =>
  Effect.succeed<DeployScope>({ org: session.org, local: session.local }),
);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Settled<A> =
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string };

/** A runtime call that may reject, as its value or the sentence it rejected with. */
const settle = <A>(call: () => Promise<A>): Effect.Effect<Settled<A>> =>
  Effect.promise(() =>
    call().then(
      (value): Settled<A> => ({ ok: true, value }),
      (e: unknown): Settled<A> => ({ ok: false, error: errorText(e) }),
    ),
  );

/* ------------------------------ flags ------------------------------------ */

const envFlag = Flag.String("env").pipe(
  Flag.withAlias("e"),
  Flag.withMetavar("name"),
  Flag.withDescription("Environment to deploy (optional when the Infrafile has one)"),
  Flag.optional,
);

const planFlag = Flag.Boolean("plan").pipe(
  Flag.withDescription("Show the plan and Dockerfile, build nothing"),
  Flag.withDefault(false),
  Flag.withoutNegation,
);

const setFlag = Flag.String("set").pipe(
  Flag.withMetavar("key=value"),
  Flag.withDescription("Answer a select() without prompting (repeatable)"),
  Flag.atLeast(0),
);

/** The env every verb reads: `deploy -e prod log` and `deploy log -e prod` alike. */
const deployBase = Command.make("deploy", { plan: planFlag, set: setFlag }).pipe(
  Command.withSharedFlags({ env: envFlag }),
);

const sharedEnv = Effect.map(deployBase, (input) => Option.getOrUndefined(input.env));

/* -------------------------- the Infrafile -------------------------------- */

/**
 * Walk up from `cwd` looking for an Infrafile.
 *
 * The search stops at the repository root: a directory containing `.git`. An
 * Infrafile lives at a repo root by definition, so climbing past one would pick
 * up an unrelated project's file and then build *its* directory as the context,
 * with this repo's git facts attached. Outside a repo there is no such boundary,
 * so the walk runs to the filesystem root.
 *
 * The directory holding the file is also the Docker build context; being the
 * same directory is what makes there be nothing to configure.
 */
const exists = (file: string) =>
  Effect.promise(() =>
    access(file).then(
      () => true,
      () => false,
    ),
  );

const findInfrafile = Effect.fnUntraced(function* (from: string) {
  const start = path.resolve(from);
  let dir = start;
  for (;;) {
    const file = path.join(dir, INFRAFILE_NAME);
    if (yield* exists(file)) return { dir, file };
    // Nothing here, but if this is the repo root, the search ends.
    if (yield* exists(path.join(dir, ".git"))) {
      return yield* new CliUsageError({
        message:
          `No ${INFRAFILE_NAME} at the root of this repository (${dir}).\n` +
          `An Infrafile lives beside your .git directory.`,
      });
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return yield* new CliUsageError({
        message: `No ${INFRAFILE_NAME} found in ${start} or any parent directory.`,
      });
    }
    dir = parent;
  }
});

/** The envs an Infrafile declares (`envs: ["staging", "prod"]`), read without running it. */
function declaredEnvs(source: string): string[] {
  const match = source.match(/envs\s*:\s*\[([^\]]*)\]/);
  return match?.[1] ? [...match[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!) : [];
}

/** Best-effort git facts. A directory that isn't a repo still deploys. */
const gitContext = (dir: string) =>
  Effect.promise(async (): Promise<InfrafileGitContext> => {
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
  });

/** Parse `--set key=value` pairs into the answers a non-interactive run needs. */
const parseAnswers = Effect.fnUntraced(function* (pairs: ReadonlyArray<string>) {
  const answers: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      return yield* new CliUsageError({
        message: `--set expects key=value, got ${JSON.stringify(pair)}.`,
      });
    }
    answers[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return answers;
});

/* --------------------------- the accounts tree ---------------------------- */

/** The merged accounts tree plus the routing table `getClient` needs. */
interface DeployPluginTree {
  plugins: WorkflowPluginInfo[];
  /** Org account ids → where their client lives. Empty for `--local` runs. */
  orgAccounts: Map<string, { orgId: string; pluginId: string }>;
}

/**
 * The org whose accounts the Infrafile sees, per the scope: `--local` → none,
 * `--org` → that org (failures propagate: the user named it), no flag → the
 * default org, degrading to local-only when the cloud is not reachable. A
 * deploy must never fail because the org could not be listed.
 */
const resolveDeployOrg = Effect.fnUntraced(function* (scope: DeployScope) {
  if (scope.local) return null;
  const api = yield* CloudApi;
  const lookup = Effect.gen(function* () {
    const org = yield* api.resolveOrg(scope.org);
    return { org, accounts: yield* cloudAccounts(org.id) };
  });
  if (scope.org) return yield* lookup;
  const note = (msg: string) =>
    Effect.sync(() => {
      printErr(c.dim(`org accounts unavailable (${msg}). Using local accounts only`));
      return null;
    });
  return yield* lookup.pipe(
    Effect.catch((e) => note(e.message)),
    Effect.catchDefect((d) => note(errorText(d))),
  );
});

const OrgPlugins = Schema.Array(Schema.Struct({ id: Schema.String, displayName: Schema.String }));

/**
 * Build the accounts tree from the local database plus the scoped org. Mirrors
 * the renderer's `listLocalPlugins`, but only needs enough for
 * `infra.accounts.<plugin>` to resolve: create-field enrichment is a
 * typings-path concern and would hit provider APIs on every deploy.
 *
 * Resource-type metadata always comes from the locally loaded plugin
 * definitions (the same code the server runs) so a plugin with only org
 * accounts (gcp connected in the cloud, nothing local) still gets its full
 * `resourceTypes`. The org rows only contribute accounts.
 */
const listPluginTree = Effect.fnUntraced(function* (scope: DeployScope) {
  const api = yield* CloudApi;
  const orgAccountRoutes = new Map<string, { orgId: string; pluginId: string }>();
  const [localAccounts, cloud] = yield* Effect.all(
    [Effect.promise(() => listLocalAccounts()), resolveDeployOrg(scope)],
    { concurrency: "unbounded" },
  );
  const cloudAccountList = cloud?.accounts ?? [];
  if (localAccounts.length === 0 && cloudAccountList.length === 0) {
    return { plugins: [], orgAccounts: orgAccountRoutes };
  }
  const { loadPlugins, getPlugin } = yield* Effect.promise(
    () => import("../../infrafile/plugins.js"),
  );
  const loaded = yield* Effect.promise(() => loadPlugins());

  const addOrgAccounts = (
    org: OrgInfo,
    orgMine: AccountInfo[],
    localNames: Set<string>,
  ): WorkflowPluginInfo["accounts"] =>
    orgMine.map((a) => {
      orgAccountRoutes.set(a.id, { orgId: org.id, pluginId: a.pluginId });
      return {
        id: a.id,
        pluginId: a.pluginId,
        // A name that collides with a local account's would make two select()
        // options read identically; the org's name disambiguates.
        displayName: localNames.has(a.displayName)
          ? `${a.displayName} (${org.displayName})`
          : a.displayName,
      };
    });

  const tree: WorkflowPluginInfo[] = [];
  const knownPluginIds = new Set<string>();
  for (const { plugin } of loaded) {
    knownPluginIds.add(plugin.manifest.id);
    const localMine = localAccounts.filter((a) => a.pluginId === plugin.manifest.id);
    const orgMine = cloudAccountList.filter((a) => a.pluginId === plugin.manifest.id);
    if (localMine.length === 0 && orgMine.length === 0) continue;
    tree.push({
      pluginId: plugin.manifest.id,
      displayName: plugin.manifest.displayName,
      accounts: [
        ...localMine.map((a) => ({ id: a.id, pluginId: a.pluginId, displayName: a.displayName })),
        ...(cloud
          ? addOrgAccounts(cloud.org, orgMine, new Set(localMine.map((a) => a.displayName)))
          : []),
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

  // Peer plugins each resource type exposes (a cluster's `kubernetes`, a
  // managed database's `postgres`). Functional, not typings garnish: the
  // prelude builds `cluster.kubernetes` (including its resource groups and
  // importYaml) from exactly this, so without it sidecars are undefined
  // inside the sandbox.
  const { attachSidecarInfo } = yield* Effect.promise(
    () => import("@infrawrench/workflow-runtime"),
  );
  yield* Effect.promise(() =>
    Promise.all(
      tree.map((entry) => {
        const lp = loaded.find(({ plugin }) => plugin.manifest.id === entry.pluginId);
        if (!lp) return Promise.resolve();
        return attachSidecarInfo(
          entry.resourceTypes,
          lp.plugin.resourceTypes,
          async (id) => (await getPlugin(id))?.plugin,
        );
      }),
    ),
  );

  // Org accounts whose plugin this build does not carry still resolve as
  // accounts; identity comes from the org's plugin metadata (GET
  // /accounts/plugins), and with no local type definitions the resourceTypes
  // stay empty.
  const orphans = cloudAccountList.filter((a) => !knownPluginIds.has(a.pluginId));
  if (orphans.length > 0 && cloud) {
    const plugins = yield* api
      .decode(OrgPlugins, cloud.org.id, "/accounts/plugins")
      // Identity falls back to the plugin id.
      .pipe(bestEffort(() => []));
    const names = new Map(plugins.map((p) => [p.id, p.displayName]));
    const byPlugin = new Map<string, AccountInfo[]>();
    for (const a of orphans) byPlugin.set(a.pluginId, [...(byPlugin.get(a.pluginId) ?? []), a]);
    for (const [pluginId, mine] of byPlugin) {
      tree.push({
        pluginId,
        displayName: names.get(pluginId) ?? pluginId,
        accounts: addOrgAccounts(cloud.org, mine, new Set()),
        resourceTypes: [],
      });
    }
  }
  const result: DeployPluginTree = { plugins: tree, orgAccounts: orgAccountRoutes };
  return result;
});

/**
 * A live plugin client for one locally-stored account, found by id. The
 * plugin id rides along because a sidecar resolution needs to know which
 * plugin's resource types declare the peer integration.
 */
async function resolveLocalClient(
  accountId: string,
): Promise<{ client: HostPluginClient; pluginId: string }> {
  const accounts = await listLocalAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Account "${accountId}" not found.`);
  return {
    client: await createLocalPluginClient(accountId, account.pluginId),
    pluginId: account.pluginId,
  };
}

/** The org API calls an org account's client makes, run on the handler's services. */
const orgTransport = (runner: Runner): OrgTransport => ({
  json: (orgId, apiPath, init) => runner(CloudApi.use((api) => api.json(orgId, apiPath, init))),
  resources: (orgId, accountId) => runner(cloudResources(orgId, accountId)),
  sync: (orgId, accountId) => runner(syncCloud(orgId, accountId)),
});

/**
 * The workflow host wired to this machine's accounts plus the scoped org's.
 * `prompt` is the only part that differs per caller: a deploy answers
 * `select(...)` at the terminal, while the ledger commands (`status`,
 * `destroy --created`) have nothing to ask and pass one that throws.
 *
 * The tree is assembled up front: `getClient` routes by account id, and the
 * ledger commands call `listResources`/`deleteResource` with recorded ids
 * without ever going through `listPlugins`.
 */
const buildCliWorkflowHost = Effect.fnUntraced(function* (
  scope: DeployScope,
  prompt: (spec: PromptSpec) => Promise<MetricValue>,
  given?: DeployPluginTree,
) {
  const runner = yield* makeRunner;
  const transport = orgTransport(runner);
  const { buildWorkflowHost } = yield* Effect.promise(
    () => import("@infrawrench/workflow-runtime"),
  );
  const { plugins, orgAccounts } = given ?? (yield* listPluginTree(scope));
  const host: WorkflowHost = buildWorkflowHost({
    listPlugins: async () => plugins,
    getClient: async (accountId: string, sidecar?: SidecarRef) => {
      // The parent client resolves the same way with or without a sidecar:
      // local accounts run the plugin off decrypted local credentials, org
      // accounts off credentials fetched over the org API (with the REST
      // fallback inside `createOrgClient`).
      const route = orgAccounts.get(accountId);
      const parent = route
        ? {
            client: await createOrgClient(transport, route.orgId, accountId, route.pluginId),
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
  return host;
});

/* ------------------------------ the scope -------------------------------- */

/**
 * Ask, BEFORE the isolate starts, whose cloud accounts this run sees: one of
 * the operator's organizations (merged with the local workspace) or the local
 * workspace alone. Deciding it up front means `infra.accounts` is settled by
 * the time `plan()` first reads it, which accounts exist is scope, not
 * something a plan should discover mid-run.
 *
 * Only asks when there is genuinely a question: an interactive terminal, no
 * `--org`/`--local` already saying the answer, and at least one org to offer.
 * Everything downstream (the accounts tree, run recording, plan diffs)
 * follows the scope this answers.
 */
const chooseDeployScope = Effect.fnUntraced(function* (scope: DeployScope, json: boolean) {
  const stdio = yield* Stdio.Stdio;
  if (scope.org || scope.local || json || !(yield* stdio.stdinIsTerminal)) return scope;
  const api = yield* CloudApi;
  // Not signed in: the tree builder already degrades to local.
  const orgs = yield* api.listOrgs.pipe(bestEffort(() => []));
  if (orgs.length === 0) return scope;
  const LOCAL_ONLY = "__local__";
  const chosen = yield* selectOne("Accounts scope", [
    ...orgs.map((o) => ({ label: `local + ${o.displayName}`, value: o.id })),
    { label: "local workspace only", value: LOCAL_ONLY },
  ]);
  const next: DeployScope =
    chosen === LOCAL_ONLY ? { org: null, local: true } : { org: chosen, local: false };
  return next;
});

/* ------------------------------ history ---------------------------------- */

const DeployRunRow = Schema.Struct({
  id: Schema.String,
  env: Schema.String,
  gitSha: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
  // Coloured for the two outcomes, printed as it is otherwise.
  status: Schema.String,
  origin: Schema.String,
  durationMs: Schema.NullOr(Schema.Finite),
  startedAt: Schema.String,
});
type DeployRunRow = typeof DeployRunRow.Type;
const DeployRunRows = Schema.Array(DeployRunRow);

/** One run's detail: what `--plan` diffs against and `deploy outputs` prints. */
const RunDetail = Schema.Struct({
  planJson: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
});

const runsPath = (env: string | undefined) =>
  `${RUNS_PATH}${env ? `?env=${encodeURIComponent(env)}` : ""}`;

const whenCell = (startedAt: string) =>
  new Date(startedAt).toISOString().slice(0, 16).replace("T", " ");
const statusCell = (status: string) =>
  status === "success" ? c.green(status) : status === "failure" ? c.red(status) : safe(status);
const tookCell = (durationMs: number | null) =>
  durationMs === null ? "—" : `${Math.round(durationMs / 1000)}s`;

/** The `--local` half of `deploy log`: runs built by this machine's Docker. */
const printLocalLog = Effect.fnUntraced(function* (env: string | undefined) {
  const session = yield* CliSession;
  const history = yield* LocalDeployHistory;
  const runs = (yield* history.list).filter((r) => !env || r.env === env);

  if (session.output === "json") return yield* Print.json(runs);
  if (runs.length === 0) {
    return yield* Print.line(
      c.dim("No local deploys yet. Run `infrawrench deploy` in a project directory."),
    );
  }
  const columns: Column<LocalDeployRun>[] = [
    { header: "when", value: (r) => whenCell(r.startedAt) },
    { header: "env", value: (r) => r.env || "—" },
    {
      header: "commit",
      value: (r) => (r.gitSha ? `${r.gitSha.slice(0, 7)}${r.dirty ? "*" : ""}` : "—"),
    },
    { header: "image", value: (r) => r.image ?? "—" },
    { header: "status", value: (r) => statusCell(r.status) },
    { header: "took", value: (r) => tookCell(r.durationMs), align: "right" },
    { header: "where", value: (r) => r.dir },
  ];
  yield* Print.table(runs, columns);
  if (runs.some((r) => r.dirty)) {
    yield* Print.line("");
    yield* Print.line(c.dim("* built from a working tree with uncommitted changes"));
  }
});

/**
 * `infrawrench deploy log`: deploy history, newest first.
 *
 * `--local` reads this machine's own runs (the same list the desktop app's
 * Deploy tab shows in local mode); anything else reads the organization's.
 */
const log = Command.make(
  "log",
  {},
  Effect.fn("deploy.log")(function* () {
    const session = yield* CliSession;
    const env = yield* sharedEnv;
    if (session.local) return yield* printLocalLog(env);
    const api = yield* CloudApi;
    const org = yield* api.resolveOrg(session.org);
    const apiPath = runsPath(env);
    const body = yield* api.json(org.id, apiPath);
    if (session.output === "json") return yield* Print.json(body);
    const rows = yield* decodeBody(DeployRunRows, apiPath)(body);
    const columns: Column<DeployRunRow>[] = [
      { header: "when", value: (r) => whenCell(r.startedAt) },
      { header: "env", value: (r) => safe(r.env) || "—" },
      { header: "commit", value: (r) => (r.gitSha ? safe(r.gitSha.slice(0, 7)) : "—") },
      { header: "image", value: (r) => (r.image === null ? "—" : safe(r.image)) },
      { header: "status", value: (r) => statusCell(r.status) },
      { header: "took", value: (r) => tookCell(r.durationMs), align: "right" },
      { header: "from", value: (r) => safe(r.origin) },
    ];
    yield* Print.table(rows, columns);
  }),
).pipe(Command.withDescription("Recent deploys for the organization (--local: this machine's)"));

const RollbackResult = Schema.Struct({
  result: Schema.Struct({
    status: Schema.String,
    image: Schema.optional(Schema.String),
    env: Schema.String,
    notes: Schema.optional(Schema.Array(Schema.String)),
    error: Schema.optional(Schema.Struct({ message: Schema.String })),
  }),
});
const RollbackEnvelope = Schema.Struct({ result: Schema.Unknown });

/**
 * `infrawrench deploy rollback`: ship a previous run's artifact again.
 *
 * The rollback itself happens server-side: it re-reads the Infrafile at the
 * commit that run deployed and replays its `deploy()` with the recorded image,
 * so nothing is rebuilt and the local working tree is irrelevant.
 */
const rollback = Command.make(
  "rollback",
  {
    toRun: Flag.String("to-run").pipe(
      Flag.withMetavar("runId"),
      Flag.withDescription("Which run to go back to (default: the one before the live deploy)"),
      Flag.optional,
    ),
    deleteCreated: Flag.Boolean("delete-created").pipe(
      Flag.withDescription("Also delete resources newer runs created"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("deploy.rollback")(function* (input) {
    const session = yield* CliSession;
    if (session.local) {
      return yield* new CliUsageError({
        message: "Rollback needs the cloud deploy history. Pass --org instead.",
      });
    }
    const api = yield* CloudApi;
    const env = yield* sharedEnv;
    const org = yield* api.resolveOrg(session.org);
    const json = session.output === "json";

    let target = Option.getOrUndefined(input.toRun);
    if (!target) {
      // Default to the last success for the env, which is what "roll back"
      // means when nobody names a run.
      const rows = yield* api.decode(DeployRunRows, org.id, runsPath(env));
      const candidates = rows.filter((r) => r.status === "success" && r.image);
      // [0] is the deploy currently live, so [1] is the one to go back to.
      const previous = candidates[1];
      if (!previous) {
        return yield* new CliUsageError({
          message:
            "No earlier successful deploy to roll back to. Pass --to-run <runId> to choose one.",
        });
      }
      target = previous.id;
      if (!json) {
        yield* Print.line(
          `${c.dim("rolling back to")} ${safe(previous.image)} ${c.dim(`(${safe(previous.id)})`)}`,
        );
      }
    }

    const apiPath = `${RUNS_PATH}/${encodeURIComponent(target)}/rollback`;
    const body = yield* api.json(org.id, apiPath, {
      method: "POST",
      ...(input.deleteCreated ? { body: JSON.stringify({ deleteCreated: true }) } : {}),
    });
    const { result } = yield* decodeBody(RollbackResult, apiPath)(body);

    if (json) {
      yield* Print.json((yield* decodeBody(RollbackEnvelope, apiPath)(body)).result);
    } else if (result.status === "success") {
      yield* Print.line(
        `${c.green("✓")} rolled back to ${c.bold(safe(result.image ?? ""))} on ${c.bold(safe(result.env))}`,
      );
      // With --delete-created the notes carry what was (and wasn't) undone.
      if (input.deleteCreated) {
        for (const note of result.notes ?? []) {
          if (note.startsWith("deleted ")) yield* Print.line(`${c.green("✓")} ${safe(note)}`);
          else if (note.startsWith("could not delete ")) {
            yield* Print.line(`${c.yellow("!")} ${safe(note)}`);
          }
        }
      }
    }
    if (result.status !== "success") {
      return yield* new CliFailure({ message: result.error?.message ?? "Rollback failed." });
    }
  }),
).pipe(Command.withDescription("Ship a previous deploy's image again"));

/** The plan the env's last successful deploy recorded, or undefined. */
const fetchPreviousPlan = Effect.fnUntraced(function* (scope: DeployScope, env: string) {
  if (scope.local) {
    const history = yield* LocalDeployHistory;
    const previous = (yield* history.list).find(
      (r) => r.env === env && r.status === "success" && r.plan !== undefined && r.plan !== null,
    );
    return previous?.plan;
  }
  const api = yield* CloudApi;
  const org = yield* api.resolveOrg(scope.org);
  const rows = yield* api.decode(DeployRunRows, org.id, runsPath(env));
  const last = rows.find((r) => r.status === "success");
  if (!last) return undefined;
  const row = yield* api.decode(RunDetail, org.id, `${RUNS_PATH}/${encodeURIComponent(last.id)}`);
  return row.planJson ?? undefined;
});

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

const PlainObject = Schema.Record(Schema.String, Schema.Unknown);
const asPlainObject = (value: unknown): Readonly<Record<string, unknown>> =>
  Option.getOrElse(Schema.decodeUnknownOption(PlainObject)(value), () => ({}));

/**
 * Shallow-diff this plan against the previous successful deploy's. Best-effort
 * by contract: the plan itself is already on the screen, so nothing that goes
 * wrong in here may escape; a diff that cannot be computed simply does not
 * appear (offline, signed out, or a server without plan storage).
 */
const printPlanDiff = (scope: DeployScope, env: string, plan: unknown) =>
  Effect.gen(function* () {
    const previousPlan = yield* fetchPreviousPlan(scope, env);
    if (previousPlan === undefined) {
      return yield* Print.line(c.dim("No previous deploy to diff against."));
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
    if (lines.length === 0) return yield* Print.line(c.dim("No changes since last deploy."));
    yield* Print.line("Changes since last deploy:");
    for (const line of lines) yield* Print.line(line);
  }).pipe(bestEffort(() => undefined));

/** What a run reports, for recording it. */
interface RunRecord {
  readonly env: string;
  readonly status: string;
  readonly image?: string | undefined;
  readonly reachedStage?: string | undefined;
  readonly notes: string[];
  readonly createdResources?: InfrafileCreatedResource[] | undefined;
  readonly output?: unknown;
  readonly plan?: unknown;
  readonly durationMs: number;
  readonly error?: { readonly message: string } | undefined;
}

function isDeployStatus(status: string): status is LocalDeployRun["status"] {
  return ["success", "failure", "canceled", "running", "pending"].includes(status);
}

/** A run in this machine's history. Best-effort by contract, like the file it appends to. */
const recordLocal = (entry: LocalDeployRun) => Effect.sync(() => recordLocalDeploy(entry));

/**
 * Record a run. Two destinations, and they are not alternatives:
 *
 * - The org, so a terminal deploy and a web deploy share one history. Skipped
 *   for `--local`, and best-effort otherwise: a deploy that worked must not be
 *   reported as failed because the record afterwards did not land (not
 *   signed in, offline, or no permission).
 * - This machine, always: including `--local`, which has no org to report to.
 *   That is what the desktop app's Deploy tab reads when no org is selected.
 */
const recordRun = Effect.fnUntraced(function* (
  scope: DeployScope,
  result: RunRecord,
  git: InfrafileGitContext,
  dir: string,
  startedAt: number,
) {
  const api = yield* CloudApi;
  const orgId = scope.local
    ? null
    : yield* Effect.gen(function* () {
        const org = yield* api.resolveOrg(scope.org);
        yield* api.json(org.id, RUNS_PATH, {
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
        return org.id;
      }).pipe(bestEffort(() => null));

  yield* recordLocal({
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
  });
});

/**
 * `infrawrench deploy outputs`: what the last successful deploy's
 * `infra.output({...})` declared. The org's record for cloud-visible runs,
 * this machine's for `--local`.
 */
const outputs = Command.make(
  "outputs",
  {},
  Effect.fn("deploy.outputs")(function* () {
    const session = yield* CliSession;
    const env = yield* sharedEnv;
    let output: unknown;
    if (session.local) {
      const history = yield* LocalDeployHistory;
      const successes = (yield* history.list).filter(
        (r) => (!env || r.env === env) && r.status === "success",
      );
      if (successes.length === 0) {
        return yield* new CliFailure({ message: "No successful deploy found." });
      }
      output = successes.find((r) => r.output !== undefined && r.output !== null)?.output;
    } else {
      const api = yield* CloudApi;
      const org = yield* api.resolveOrg(session.org);
      const rows = yield* api.decode(DeployRunRows, org.id, runsPath(env));
      const last = rows.find((r) => r.status === "success");
      if (!last) return yield* new CliFailure({ message: "No successful deploy found." });
      const row = yield* api.decode(
        RunDetail,
        org.id,
        `${RUNS_PATH}/${encodeURIComponent(last.id)}`,
      );
      output = row.output;
    }

    if (session.output === "json") return yield* Print.json(output ?? null);
    if (output === undefined || output === null) {
      return yield* Print.line(
        c.dim(
          "The last successful deploy recorded no output. Call infra.output({...}) in deploy().",
        ),
      );
    }
    yield* Print.line(JSON.stringify(output, null, 2));
  }),
).pipe(Command.withDescription("Print the last successful deploy's infra.output(...) value"));

/* ------------------------------ the ledger -------------------------------- */

/** A ledger entry plus the env whose run created it. */
type LedgerResource = LocalDeployRun["createdResources"][number] & { env: string };

/**
 * Everything the local ledger says still exists: created resources across all
 * recorded runs (newest run first, and within a run in reverse creation order,
 * so children come before their parents), deduped to the newest record per
 * accountId:resourceTypeId:resourceId.
 */
const collectLedgerResources = Effect.fnUntraced(function* (env: string | undefined) {
  const history = yield* LocalDeployHistory;
  const seen = new Set<string>();
  const found: LedgerResource[] = [];
  for (const entry of yield* history.list) {
    if (env && entry.env !== env) continue;
    for (const res of [...(entry.createdResources ?? [])].reverse()) {
      const key = `${res.accountId}:${res.resourceTypeId}:${res.resourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...res, env: entry.env });
    }
  }
  return found;
});

const neverPrompts = (command: string) => async (): Promise<never> => {
  throw new CliError(`${command} never prompts.`, 2);
};

type LedgerState = "ok" | "missing" | "unknown";

/**
 * `infrawrench deploy status`: is what the ledger says was created still
 * there? Checked against the LOCAL deploy history on purpose: that is where
 * CLI-created resources are recorded, so it is the only ledger this machine
 * can vouch for. Each (account, type) pair is listed once via the providers.
 */
const status = Command.make(
  "status",
  {},
  Effect.fn("deploy.status")(function* () {
    const session = yield* CliSession;
    const json = session.output === "json";
    const resources = yield* collectLedgerResources(yield* sharedEnv);
    if (resources.length === 0) {
      if (json) return yield* Print.json([]);
      return yield* Print.line(
        c.dim("Nothing recorded. Deploys that create resources will appear here."),
      );
    }

    const host = yield* buildCliWorkflowHost(yield* sessionScope, neverPrompts("deploy status"));

    // One listing per (account, type) pair; null marks a pair whose provider
    // call failed, so its resources report "unknown" rather than "missing".
    const listings = new Map<string, ResourceInstanceLite[] | null>();
    for (const res of resources) {
      if (res.sidecar) continue;
      const key = `${res.accountId} ${res.resourceTypeId}`;
      if (listings.has(key)) continue;
      const listed = yield* settle(() => host.listResources(res.accountId, res.resourceTypeId));
      if (listed.ok) {
        listings.set(key, listed.value);
      } else {
        listings.set(key, null);
        yield* Print.errLine(
          c.dim(`could not list ${res.resourceTypeId} on ${res.accountId}: ${listed.error}`),
        );
      }
    }

    const stateOf = (res: LedgerResource): LedgerState => {
      // Listing through a sidecar needs the parent context: out of scope here.
      if (res.sidecar) return "unknown";
      const listed = listings.get(`${res.accountId} ${res.resourceTypeId}`);
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
      return yield* Print.json(
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
    }

    yield* Print.table(states, [
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
    const count = (state: LedgerState): number => states.filter((s) => s.state === state).length;
    yield* Print.line("");
    yield* Print.line(
      c.dim(`${count("ok")} ok, ${count("missing")} missing, ${count("unknown")} unknown`),
    );
  }),
).pipe(Command.withDescription("Check the resources the local ledger says exist"));

/**
 * `infrawrench deploy destroy --created`; no Infrafile involved: delete what
 * the local ledger says this env's runs created, children before parents.
 */
const destroyCreated = Effect.fnUntraced(function* (env: string | undefined) {
  if (!env) {
    return yield* new CliUsageError({ message: "Deleting by ledger needs an explicit --env." });
  }
  const session = yield* CliSession;
  const stdio = yield* Stdio.Stdio;
  const json = session.output === "json";

  if (!json && (yield* stdio.stdinIsTerminal)) {
    if (!(yield* confirm(`Delete every resource the local ledger says "${env}" created?`))) {
      return yield* new CliFailure({ message: "Aborted. Nothing was deleted." });
    }
  }

  const startedAt = Date.now();
  const resources = yield* collectLedgerResources(env);
  if (resources.length === 0) {
    if (json) return yield* Print.json({ env, deleted: 0, failed: 0, notes: [] });
    return yield* Print.line(
      c.dim("Nothing recorded. Deploys that create resources will appear here."),
    );
  }

  const host = yield* buildCliWorkflowHost(
    yield* sessionScope,
    neverPrompts("deploy destroy --created"),
  );
  const deleteResource = host.deleteResource;
  if (!deleteResource) {
    return yield* new CliFailure({ message: "This host cannot delete resources." });
  }

  const notes: string[] = [];
  let deleted = 0;
  let failed = 0;
  for (const res of resources) {
    const label = `${res.resourceTypeId} ${res.displayName}`;
    const outcome = yield* settle(() =>
      deleteResource(res.accountId, res.resourceTypeId, res.resourceId, res.sidecar),
    );
    if (outcome.ok) {
      deleted += 1;
      notes.push(`deleted ${label}`);
      if (!json) yield* Print.line(`${c.green("✓")} deleted ${label}`);
    } else {
      failed += 1;
      notes.push(`could not delete ${label}: ${outcome.error}`);
      if (!json) yield* Print.line(`${c.yellow("!")} could not delete ${label}: ${outcome.error}`);
    }
  }

  if (json) {
    yield* Print.json({ env, deleted, failed, notes });
  } else {
    yield* Print.line("");
    yield* Print.line(`${deleted} deleted, ${failed} failed`);
  }

  const git = yield* gitContext(process.cwd());
  yield* recordLocal({
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
});

/* ------------------------------ the run ---------------------------------- */

/** Print the writes a `--plan` run intercepted, terraform-style. */
const printPlannedChanges = Effect.fnUntraced(function* (changes: InfrafilePlannedChange[]) {
  yield* Print.line(c.bold("Planned changes"));
  if (changes.length === 0) return yield* Print.line(c.dim("No resource changes."));
  let creates = 0;
  let updates = 0;
  let deletes = 0;
  for (const change of changes) {
    const line = `${change.resourceTypeId} ${change.displayName}`;
    if (change.action === "create") {
      creates += 1;
      yield* Print.line(`${c.green("+")} ${line}`);
    } else if (change.action === "update") {
      updates += 1;
      yield* Print.line(`${c.yellow("~")} ${line}`);
    } else {
      deletes += 1;
      yield* Print.line(`${c.red("-")} ${line}`);
    }
  }
  yield* Print.line(c.dim(`${creates} to create, ${updates} to update, ${deletes} to delete`));
});

/**
 * One deploy, or (`destroy`) the Infrafile's destroy() stage: find the file,
 * settle the scope, run it in the sandbox with this machine's Docker, print
 * as it goes, record the run.
 */
const runDeploy = Effect.fnUntraced(function* (options: {
  readonly destroy: boolean;
  readonly env: string | undefined;
  readonly plan: boolean;
  readonly set: ReadonlyArray<string>;
}) {
  const session = yield* CliSession;
  const stdio = yield* Stdio.Stdio;
  const runner = yield* makeRunner;
  const { destroy } = options;
  const startedAt = Date.now();
  const { dir, file } = yield* findInfrafile(process.cwd());
  const source = yield* Effect.promise(() => readFile(file, "utf8"));
  const git = yield* gitContext(dir);
  const answers = yield* parseAnswers(options.set);
  const json = session.output === "json";
  const interactive = yield* stdio.stdinIsTerminal;

  // Scope first: whose cloud accounts does this run see? Settled before the
  // sandbox starts (and before the ledger/plan lookups below, which follow the
  // same scope).
  const scope = yield* chooseDeployScope(yield* sessionScope, json);

  // Tearing down is the one deploy-shaped action with nothing to preview, so a
  // person at a terminal gets asked once. Non-interactive runs (CI teardown of
  // a preview env) proceed: there is nobody to ask, and that is the use case.
  if (destroy && !json && interactive) {
    const target = options.env ? `"${options.env}"` : "this project's environment";
    if (!(yield* confirm(`Tear down ${target}? This runs the Infrafile's destroy() stage.`))) {
      return yield* new CliFailure({ message: "Aborted. Nothing was torn down." });
    }
  }

  // destroy() never prompts, so anything env and git cannot name has to come
  // from state the deploy wrote down: hand it the env's last successful
  // deploy's recorded plan. Best-effort by contract: a teardown must not fail
  // because the org was unreachable; the stage just sees no plan. The plan
  // lookup needs the env before the runtime resolves it; a file declaring
  // exactly one env is read the same way `deploy typings` does.
  let destroyPlan: unknown;
  if (destroy) {
    const declared = declaredEnvs(source);
    const env = options.env ?? (declared.length === 1 ? declared[0] : undefined);
    if (env) destroyPlan = yield* fetchPreviousPlan(scope, env).pipe(bestEffort(() => undefined));
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
    yield* Print.line(c.bold(shown === INFRAFILE_NAME ? INFRAFILE_NAME : shown));
    yield* Print.line(
      `${c.dim("commit")}  ${git.sha.slice(0, 7)} ${c.dim(`(${git.branch})`)}${
        git.dirty ? ` ${c.yellow("· uncommitted changes")}` : ""
      }`,
    );
    yield* Print.line("");
  }

  const tree = yield* listPluginTree(scope);

  // Everything the run needs from this machine and the scoped org.
  // `buildWorkflowHost` would give us the full resource surface, but it wants
  // a client factory, which is exactly what the account-id routing in
  // `buildCliWorkflowHost` provides.
  const { runInfrafile } = yield* Effect.promise(() => import("@infrawrench/workflow-runtime"));
  const base = yield* buildCliWorkflowHost(
    scope,
    (spec: PromptSpec) => {
      const choices = (spec.options ?? []).map((o) => ({
        label: o.label,
        value: o.value,
        ...(o.hint ? { hint: o.hint } : {}),
      }));
      if (choices.length > 0) return runner(selectOne(spec.message, choices));
      if (spec.kind === "boolean") return runner(confirm(spec.message));
      // Everything else is typed text. The runtime validates and coerces the
      // answer, so the terminal only has to collect the characters: a number
      // that isn't one is rejected there with the key named, not here.
      const hint =
        spec.kind === "date"
          ? `${spec.message} (YYYY-MM-DD)`
          : spec.kind === "number"
            ? `${spec.message} (number)`
            : spec.message;
      return runner(askText(hint, spec.defaultValue ?? ""));
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

  const result = yield* Effect.promise(() =>
    runInfrafile({
      source,
      host,
      git,
      // A deploy legitimately waits on real infrastructure (provisioning a
      // managed cluster can take ten-plus minutes) so the runaway-code budget
      // gets an hour rather than the default five.
      limits: { timeoutMs: 60 * 60 * 1000 },
      // Undefined lets the runner pick when the file declares exactly one env,
      // and otherwise fail naming the ones it declares.
      ...(options.env ? { env: options.env } : {}),
      interactive,
      planOnly: options.plan,
      ...(destroy ? { destroy: true } : {}),
      ...(destroy && destroyPlan !== undefined ? { destroyPlan } : {}),
      // Printed as the run reports them, not after: these are the progress.
      onLog: (entry) => {
        if (!json) println(entry.level === "error" ? c.red(entry.message) : entry.message);
      },
      onStage: (stage) => {
        if (!json) println(c.dim(`[${stage}]`));
      },
    }),
  );

  if (json) {
    yield* Print.json({
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
    yield* Print.line("");
    if (options.plan) {
      yield* Print.line(c.bold("Plan"));
      yield* Print.line(JSON.stringify(result.plan, null, 2));
      yield* Print.line("");
      yield* Print.line(c.bold("Dockerfile"));
      yield* Print.line(result.dockerfile ?? "");
      yield* Print.line("");
      yield* printPlannedChanges(result.plannedChanges);
      yield* Print.line("");
      yield* printPlanDiff(scope, result.env, result.plan);
      yield* Print.line("");
      yield* Print.line(c.dim("Nothing was built. Re-run without --plan to deploy."));
    } else if (destroy) {
      yield* Print.line(`${c.green("✓")} destroyed ${c.bold(result.env)}`);
    } else {
      yield* Print.line(
        `${c.green("✓")} deployed ${c.bold(result.image ?? "")} to ${c.bold(result.env)}`,
      );
    }
  }

  // Record before failing: a failed deploy is exactly the one worth having in
  // the history.
  if (!options.plan) yield* recordRun(scope, result, git, dir, startedAt);

  if (result.status !== "success") {
    let message = result.error?.message ?? "Deploy failed.";
    // The runtime's error already explains itself; the ledger path is the one
    // way out it cannot know about.
    if (destroy && message.includes("no destroy() stage")) {
      message +=
        " Or run `deploy destroy --created` to delete what the ledger says this env created.";
    }
    return yield* new CliFailure({ message });
  }
});

/**
 * `deploy destroy`: run the Infrafile's destroy() stage, tearing down what
 * deploy() created for this environment. Same host, same file discovery; the
 * runtime skips plan, dockerfile and build entirely. `--created` needs no
 * Infrafile at all: the ledger names what to delete.
 */
const destroy = Command.make(
  "destroy",
  {
    plan: planFlag.pipe(Flag.withDescription("Refused: destroy has no plan stage")),
    set: setFlag,
    created: Flag.Boolean("created").pipe(
      Flag.withDescription("Delete what the local ledger says the env created (needs -e)"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("deploy.destroy")(function* (input) {
    const env = yield* sharedEnv;
    if (input.plan) {
      return yield* new CliUsageError({
        message: "--plan previews a deploy; destroy has no plan stage.",
      });
    }
    if (input.created) return yield* destroyCreated(env);
    yield* runDeploy({ destroy: true, env, plan: false, set: input.set });
  }),
).pipe(Command.withDescription("Run the Infrafile's destroy() stage: tear the env down"));

/**
 * Write the ambient declarations for an Infrafile to stdout, so an editor can
 * type it. Generated from the caller's own accounts, exactly like a workflow's:
 * `infra.accounts.` autocompletes with real account names.
 *
 * Deliberately plain stdout with no decoration: this is meant to be redirected
 * into `Infrafile.d.ts`.
 */
const typings = Command.make(
  "typings",
  {},
  Effect.fn("deploy.typings")(function* () {
    const { generateInfrafileDts } = yield* Effect.promise(
      () => import("@infrawrench/workflow-runtime"),
    );
    const { plugins } = yield* listPluginTree(yield* sessionScope);

    // Best-effort: the envs narrow the `InfraEnv` union, and an Infrafile that
    // isn't there yet (or doesn't parse) simply gets the open `string` type.
    const envs = yield* findInfrafile(process.cwd()).pipe(
      Effect.flatMap(({ file }) => Effect.promise(() => readFile(file, "utf8"))),
      Effect.map(declaredEnvs),
      bestEffort((): string[] => []),
    );
    yield* Print.write(generateInfrafileDts({ plugins, envs }));
  }),
).pipe(Command.withDescription("Print Infrafile.d.ts for your editor"));

export const deploy = Command.withHandler(
  deployBase,
  Effect.fn("deploy")(function* (input) {
    yield* runDeploy({
      destroy: false,
      env: Option.getOrUndefined(input.env),
      plan: input.plan,
      set: input.set,
    });
  }),
).pipe(
  Command.withDescription(
    "Build & ship this project via its Infrafile (--org/--local scope which accounts the Infrafile sees)",
  ),
  Command.withSubcommands([typings, log, rollback, outputs, status, destroy]),
  Command.provide(LocalDeployHistory.layer),
);
