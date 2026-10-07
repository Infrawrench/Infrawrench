import type {
  CreateResourceConfig,
  CredentialExport,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { SlContext } from "./api.js";
import {
  SpaceliftApiError,
  accountName,
  gql,
  normaliseEndpoint,
  statusOf,
  stripAnsi,
  webBase,
} from "./api.js";
import type {
  SlConfig,
  SlContextItem,
  SlModule,
  SlPolicy,
  SlRun,
  SlSpace,
  SlStack,
  SlWorkerPool,
} from "./mappers.js";
import {
  RUN_FIELDS,
  STACK_FIELDS,
  instance,
  labelList,
  mapConfig,
  mapContext,
  mapModule,
  mapPolicy,
  mapRun,
  mapSpace,
  mapStack,
  mapWorkerPool,
  splitFirst,
  unixIso,
} from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, rangeOrDefault, runSeries } from "./metrics.js";
import type { Option, RunRow } from "./render.js";
import {
  DETAIL_KEYS,
  TRIGGER_FIELDS,
  renderSpaceliftDetail,
  renderSpaceliftSidebar,
} from "./render.js";

const RUN_LIMIT = 50;
const MAX_LOG_PAGES = 30;
const bool = (v: string | undefined) => v === "true" || v === "1";

const MINIMAL_STACK_FIELDS =
  "id name description space repository branch projectRoot administrative autodeploy labels";

const HOOK_FIELDS =
  "afterApply afterDestroy afterInit afterPerform afterPlan afterRun beforeApply beforeDestroy beforeInit beforePerform beforePlan";

/** Everything `stackUpdate` needs back, so an edit never resets a setting it did not touch. */
const STACK_UPDATE_FIELDS = `
  name description space repository branch projectRoot provider namespace repositoryURL
  administrative autodeploy autoretry labels protectFromDeletion runnerImage
  githubActionDeploy localPreviewEnabled enableWellKnownSecretMasking enableSensitiveOutputUpload
  additionalProjectGlobs gitSparseCheckoutPaths
  hooks { ${HOOK_FIELDS} }
  vcsIntegration { id }
  workerPool { id }
  vendorConfig {
    __typename
    ... on StackConfigVendorAnsible { playbook }
    ... on StackConfigVendorCloudFormation { entryTemplateFile region stackName templateBucket }
    ... on StackConfigVendorKubernetes { namespace kubectlVersion kubernetesWorkflowTool }
    ... on StackConfigVendorOpenTofu { concise externalStateAccessEnabled useSmartSanitization version workspace openTofuWorkflowTool: workflowTool }
    ... on StackConfigVendorPulumi { loginURL stackName }
    ... on StackConfigVendorTerraform { useSmartSanitization version workflowTool workspace externalStateAccessEnabled }
    ... on StackConfigVendorTerragrunt { terraformVersion terragruntVersion useRunAll useSmartSanitization useStateManagement prefixResourceNamesWithModuleName skipReplanWhenRunAll skipReplan tool }
  }
`;

type A = Record<string, unknown>;

function stash(r: ResourceInstance, data: Record<string, unknown>): ResourceInstance {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) extra[k] = JSON.stringify(v);
  return { ...r, resolvedOutputs: { ...r.resolvedOutputs, ...extra } };
}

function parseFormArg(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = String(v ?? "");
    return out;
  } catch {
    return {};
  }
}

export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + (lines.length > 0 ? "\n" : "");
}

/** A `StackInput.vendorConfig` from the `vendorConfig` a stack query returned. */
export function vendorInput(vc: A | null | undefined): A | undefined {
  if (!vc) return undefined;
  const {
    __typename: t,
    openTofuWorkflowTool,
    ...rest
  } = vc as A & { __typename?: string; openTofuWorkflowTool?: unknown };
  const pick = (keys: string[]) =>
    Object.fromEntries(
      keys.filter((k) => rest[k] !== undefined && rest[k] !== null).map((k) => [k, rest[k]]),
    );
  switch (t) {
    case "StackConfigVendorTerraform":
      return {
        terraform: pick([
          "useSmartSanitization",
          "version",
          "workflowTool",
          "workspace",
          "externalStateAccessEnabled",
        ]),
      };
    case "StackConfigVendorOpenTofu":
      return {
        opentofu: {
          ...pick([
            "concise",
            "externalStateAccessEnabled",
            "useSmartSanitization",
            "version",
            "workspace",
          ]),
          ...(openTofuWorkflowTool ? { workflowTool: openTofuWorkflowTool } : {}),
        },
      };
    case "StackConfigVendorPulumi":
      return { pulumi: pick(["loginURL", "stackName"]) };
    case "StackConfigVendorKubernetes":
      return { kubernetes: pick(["namespace", "kubectlVersion", "kubernetesWorkflowTool"]) };
    case "StackConfigVendorAnsible":
      return { ansible: pick(["playbook"]) };
    case "StackConfigVendorCloudFormation":
      return {
        cloudFormation: pick(["entryTemplateFile", "region", "stackName", "templateBucket"]),
      };
    case "StackConfigVendorTerragrunt":
      return {
        terragrunt: pick([
          "terraformVersion",
          "terragruntVersion",
          "useRunAll",
          "useSmartSanitization",
          "useStateManagement",
          "prefixResourceNamesWithModuleName",
          "skipReplanWhenRunAll",
          "skipReplan",
          "tool",
        ]),
      };
    default:
      return undefined;
  }
}

/** The full `StackInput` for an update: the current stack with `changes` applied. */
export function stackUpdateInput(current: A, changes: Record<string, string>): A {
  const has = (k: string) => k in changes;
  const text = (k: string) => (changes[k] ?? "").trim();
  const hooks = (current["hooks"] ?? {}) as A;
  const input: A = {
    name: current["name"],
    description: has("description") ? text("description") : (current["description"] ?? null),
    space: current["space"],
    repository: current["repository"],
    branch: has("branch") ? text("branch") : current["branch"],
    projectRoot: has("projectRoot") ? text("projectRoot") : (current["projectRoot"] ?? null),
    provider: current["provider"] ?? null,
    namespace: current["namespace"] ?? null,
    repositoryURL: current["repositoryURL"] ?? null,
    administrative: current["administrative"] ?? false,
    autodeploy: has("autodeploy") ? bool(changes["autodeploy"]) : (current["autodeploy"] ?? false),
    autoretry: has("autoretry") ? bool(changes["autoretry"]) : (current["autoretry"] ?? false),
    labels: has("labels") ? labelList(changes["labels"]) : (current["labels"] ?? []),
    protectFromDeletion: has("protectFromDeletion")
      ? bool(changes["protectFromDeletion"])
      : (current["protectFromDeletion"] ?? false),
    runnerImage: has("runnerImage")
      ? text("runnerImage") || null
      : (current["runnerImage"] ?? null),
    githubActionDeploy: current["githubActionDeploy"] ?? true,
    localPreviewEnabled: current["localPreviewEnabled"] ?? false,
    enableWellKnownSecretMasking: current["enableWellKnownSecretMasking"] ?? false,
    enableSensitiveOutputUpload: current["enableSensitiveOutputUpload"] ?? false,
    additionalProjectGlobs: current["additionalProjectGlobs"] ?? [],
    gitSparseCheckoutPaths: current["gitSparseCheckoutPaths"] ?? [],
    vcsIntegrationId: (current["vcsIntegration"] as A | null | undefined)?.["id"] ?? null,
    workerPool: (current["workerPool"] as A | null | undefined)?.["id"] ?? null,
  };
  for (const h of HOOK_FIELDS.split(" ")) input[h] = hooks[h] ?? [];
  const vendor = vendorInput(current["vendorConfig"] as A | undefined);
  if (vendor) input["vendorConfig"] = vendor;
  return input;
}

export class SpaceliftClient implements PluginClient {
  private readonly ctx: SlContext;
  private stacksCache: Promise<SlStack[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const keyId = (credentials["apiKeyId"] ?? "").trim();
    const keySecret = (credentials["apiKeySecret"] ?? "").trim();
    if (!keyId || !keySecret) throw new Error("Spacelift plugin: missing API key ID or secret");
    const caCert = (credentials["caCert"] ?? "").trim();
    this.ctx = {
      endpoint: normaliseEndpoint(credentials["endpoint"]),
      keyId,
      keySecret,
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
  }

  private get web(): string {
    return webBase(this.ctx.endpoint);
  }

  private q<T>(name: string, query: string, variables: A = {}): Promise<T> {
    return gql<T>(this.ctx, name, query, variables);
  }

  /** A query whose failure only means "this detail is unavailable". */
  private async soft<T>(name: string, query: string, variables: A = {}): Promise<T | undefined> {
    try {
      return await this.q<T>(name, query, variables);
    } catch {
      return undefined;
    }
  }

  private stacks(): Promise<SlStack[]> {
    this.stacksCache ??= (async () => {
      try {
        return (
          (await this.q<{ stacks?: SlStack[] }>("stacks", `{ stacks { ${STACK_FIELDS} } }`))
            .stacks ?? []
        );
      } catch (err) {
        if (statusOf(err) === 401 || statusOf(err) === 403) throw err;
        return (
          (await this.q<{ stacks?: SlStack[] }>("stacks", `{ stacks { ${MINIMAL_STACK_FIELDS} } }`))
            .stacks ?? []
        );
      }
    })().catch((err: unknown) => {
      this.stacksCache = undefined;
      throw err;
    });
    return this.stacksCache;
  }

  private stackUrl(id: string): string {
    return `${this.web}/stack/${encodeURIComponent(id)}`;
  }

  private runUrl(stackId: string, runId: string): string {
    return `${this.stackUrl(stackId)}/run/${encodeURIComponent(runId)}`;
  }

  private async stackOptions(): Promise<Option[]> {
    return (await this.stacks().catch(() => [] as SlStack[]))
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "account":
        return [await this.accountResource(accountId)];
      case "space":
        return (
          (
            await this.q<{ spaces?: SlSpace[] }>(
              "spaces",
              "{ spaces { id name description parentSpace inheritEntities labels } }",
            )
          ).spaces ?? []
        ).map((s) => mapSpace(accountId, s));
      case "stack":
        this.stacksCache = undefined;
        return (await this.stacks()).map((s) => mapStack(accountId, s, this.stackUrl(s.id)));
      case "stack-output": {
        const out: ResourceInstance[] = [];
        for (const s of await this.stacks()) {
          const res = await this.soft<{
            stack?: {
              outputs?: Array<{
                id: string;
                value?: string | null;
                sensitive?: boolean;
                description?: string;
              }>;
            };
          }>(
            "stack outputs",
            "query($id: ID!) { stack(id: $id) { outputs { id value sensitive description } } }",
            { id: s.id },
          );
          for (const o of res?.stack?.outputs ?? []) out.push(this.outputDoc(accountId, s, o));
        }
        return out;
      }
      case "run":
        return this.recentRuns(accountId);
      case "context":
        return (
          (
            await this.q<{ contexts?: SlContextItem[] }>(
              "contexts",
              "{ contexts { id name description labels space createdAt updatedAt } }",
            )
          ).contexts ?? []
        ).map((c) => mapContext(accountId, c));
      case "context-variable": {
        const res = await this.q<{ contexts?: Array<SlContextItem & { config?: SlConfig[] }> }>(
          "context variables",
          "{ contexts { id name config { id type value writeOnly description checksum } } }",
        );
        return (res.contexts ?? []).flatMap((c) =>
          (c.config ?? []).map((e) => mapConfig(accountId, c.id, c.name, e)),
        );
      }
      case "policy":
        return (
          (
            await this.q<{ policies?: SlPolicy[] }>(
              "policies",
              "{ policies { id name body type description labels space createdAt updatedAt } }",
            )
          ).policies ?? []
        ).map((p) => mapPolicy(accountId, p));
      case "module":
        return (
          (
            await this.q<{ modules?: SlModule[] }>(
              "modules",
              "{ modules { id name namespace repository provider terraformProvider space description labels administrative branch createdAt } }",
            )
          ).modules ?? []
        ).map((m) => mapModule(accountId, m));
      case "worker-pool":
        return (
          (
            await this.q<{ workerPools?: SlWorkerPool[] }>(
              "worker pools",
              "{ workerPools { id name description labels space createdAt } }",
            )
          ).workerPools ?? []
        ).map((w) => mapWorkerPool(accountId, w));
      default:
        throw new Error(`Spacelift plugin: unknown resource type "${typeId}"`);
    }
  }

  private outputDoc(
    accountId: string,
    s: { id: string; name: string },
    o: { id: string; value?: string | null; sensitive?: boolean; description?: string },
  ): ResourceInstance {
    const sensitive = o.sensitive === true;
    return instance(
      accountId,
      "stack-output",
      `${s.id}/${o.id}`,
      `${s.name}.${o.id}`,
      {
        name: o.id,
        sensitive,
        preview: sensitive ? undefined : (o.value ?? "").slice(0, 500),
        description: o.description ?? "",
        stackName: s.name,
        stackId: s.id,
      },
      { name: o.id, ...(!sensitive && typeof o.value === "string" ? { value: o.value } : {}) },
      { typeId: "stack", externalId: s.id },
    );
  }

  private async recentRuns(accountId: string): Promise<ResourceInstance[]> {
    type Edge = {
      node?: { run?: SlRun; stack?: { id: string; name: string }; isModule?: boolean };
    };
    const query = `query($input: SearchInput!) { searchRuns(input: $input) { edges { node { run { ${RUN_FIELDS} } stack { id name } isModule } } } }`;
    for (const orderBy of [true, false]) {
      const res = await this.soft<{ searchRuns?: { edges?: Edge[] } }>("searchRuns", query, {
        input: {
          first: RUN_LIMIT,
          ...(orderBy ? { orderBy: { field: "createdAt", direction: "DESC" } } : {}),
        },
      });
      if (res?.searchRuns?.edges) {
        return res.searchRuns.edges
          .map((e) => e.node)
          .filter((n): n is NonNullable<Edge["node"]> => Boolean(n?.run && n.stack && !n.isModule))
          .map((n) =>
            mapRun(
              accountId,
              n.stack!.id,
              n.stack!.name,
              n.run!,
              this.runUrl(n.stack!.id, n.run!.id),
            ),
          );
      }
    }
    // No run search on this account: read the latest runs of the most recently active stacks.
    const stacks = [...(await this.stacks())]
      .sort((a, b) => (b.stateSetAt ?? 0) - (a.stateSetAt ?? 0))
      .slice(0, 15);
    const out: ResourceInstance[] = [];
    for (const s of stacks) {
      const res = await this.soft<{ stack?: { runs?: SlRun[] } }>(
        "stack runs",
        `query($id: ID!) { stack(id: $id) { runs(before: null) { ${RUN_FIELDS} } } }`,
        {
          id: s.id,
        },
      );
      out.push(
        ...(res?.stack?.runs ?? [])
          .slice(0, 5)
          .map((r) => mapRun(accountId, s.id, s.name, r, this.runUrl(s.id, r.id))),
      );
    }
    return out
      .sort((a, b) => String(b.fields["createdAt"]).localeCompare(String(a.fields["createdAt"])))
      .slice(0, RUN_LIMIT);
  }

  private async accountResource(accountId: string): Promise<ResourceInstance> {
    const counts = await this.q<{
      stacks?: unknown[];
      spaces?: unknown[];
      workerPools?: unknown[];
    }>("account", "{ stacks { id } spaces { id } workerPools { id } }");
    const usage = (
      await this.soft<{ usage?: A }>(
        "usage",
        "{ usage { allowedMinutes allowedSeats billingPeriodStart billingPeriodEnd pricePerSeat pricePerWorker } }",
      )
    )?.usage;
    const toUnix = (v: unknown): number | undefined =>
      typeof v === "number"
        ? v
        : typeof v === "string" && Number.isFinite(Date.parse(v))
          ? Math.floor(Date.parse(v) / 1000)
          : undefined;
    const start =
      toUnix(usage?.["billingPeriodStart"]) ??
      Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000);
    const end = Math.floor(Date.now() / 1000);
    const minutes = (
      await this.soft<{
        runMinutesUsage?: { totals?: { publicMinutes?: number; privateMinutes?: number } };
      }>(
        "runMinutesUsage",
        "query($input: RunMinutesUsageInput!) { runMinutesUsage(input: $input) { totals { publicMinutes privateMinutes } } }",
        { input: { startTime: start, endTime: end } },
      )
    )?.runMinutesUsage?.totals;
    const pub = (
      await this.soft<{ publicWorkerPool?: A }>(
        "publicWorkerPool",
        "{ publicWorkerPool { parallelism busyWorkers pendingRuns } }",
      )
    )?.publicWorkerPool;
    const iso = (v: unknown) =>
      typeof v === "number" ? unixIso(v) : typeof v === "string" ? v : undefined;
    const name = accountName(this.ctx.endpoint);
    return instance(
      accountId,
      "account",
      name,
      name,
      {
        name,
        stackCount: counts.stacks?.length,
        spaceCount: counts.spaces?.length,
        workerPoolCount: counts.workerPools?.length,
        billingPeriodStart: iso(usage?.["billingPeriodStart"]),
        billingPeriodEnd: iso(usage?.["billingPeriodEnd"]),
        allowedSeats: usage?.["allowedSeats"],
        allowedMinutes: usage?.["allowedMinutes"],
        pricePerSeat: usage?.["pricePerSeat"],
        pricePerWorker: usage?.["pricePerWorker"],
        publicMinutes: minutes?.publicMinutes,
        privateMinutes: minutes?.privateMinutes,
        publicParallelism: pub?.["parallelism"],
        publicBusyWorkers: pub?.["busyWorkers"],
        publicPendingRuns: pub?.["pendingRuns"],
      },
      { name, url: this.web },
    );
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "account":
        return this.accountResource(accountId);
      case "space": {
        const res = await this.q<{ space?: SlSpace | null }>(
          "space",
          "query($id: ID!) { space(id: $id) { id name description parentSpace inheritEntities labels } }",
          { id },
        );
        if (!res.space) throw new SpaceliftApiError(404, `Spacelift plugin: space ${id} not found`);
        return mapSpace(accountId, res.space);
      }
      case "stack":
        return this.stackDetail(accountId, id);
      case "stack-output": {
        const [stackId, name] = splitFirst(id);
        const res = await this.q<{
          stack?: {
            id: string;
            name: string;
            outputs?: Array<{
              id: string;
              value?: string | null;
              sensitive?: boolean;
              description?: string;
            }>;
          } | null;
        }>(
          "stack outputs",
          "query($id: ID!) { stack(id: $id) { id name outputs { id value sensitive description } } }",
          { id: stackId },
        );
        const o = res.stack?.outputs?.find((x) => x.id === name);
        if (!res.stack || !o)
          throw new SpaceliftApiError(404, `Spacelift plugin: output ${name} not found`);
        return this.outputDoc(accountId, res.stack, o);
      }
      case "run": {
        const [stackId, runId] = splitFirst(id);
        const res = await this.q<{
          stack?: { id: string; name: string; run?: SlRun | null } | null;
        }>(
          "run",
          `query($stack: ID!, $run: ID!) { stack(id: $stack) { id name run(id: $run) { ${RUN_FIELDS} } } }`,
          { stack: stackId, run: runId },
        );
        if (!res.stack?.run)
          throw new SpaceliftApiError(404, `Spacelift plugin: run ${runId} not found`);
        return mapRun(
          accountId,
          stackId,
          res.stack.name,
          res.stack.run,
          this.runUrl(stackId, runId),
        );
      }
      case "context": {
        const res = await this.q<{ context?: (SlContextItem & { config?: SlConfig[] }) | null }>(
          "context",
          "query($id: ID!) { context(id: $id) { id name description labels space createdAt updatedAt config { id } } }",
          { id },
        );
        if (!res.context)
          throw new SpaceliftApiError(404, `Spacelift plugin: context ${id} not found`);
        const attached = await this.soft<{
          context?: {
            attachedStacks?: Array<{
              id: string;
              stackId: string;
              stackName?: string;
              isModule?: boolean;
            }>;
          };
        }>(
          "context attachments",
          "query($id: ID!) { context(id: $id) { attachedStacks { id stackId stackName isModule } } }",
          { id },
        );
        const list = attached?.context?.attachedStacks;
        return stash(
          mapContext(accountId, res.context, {
            variableCount: res.context.config?.length ?? 0,
            ...(list
              ? { attachedStacks: list.map((a) => a.stackName || a.stackId).join(", ") }
              : {}),
          }),
          { [DETAIL_KEYS.attachments]: list, [DETAIL_KEYS.stacks]: await this.stackOptions() },
        );
      }
      case "context-variable": {
        const [contextId, name] = splitFirst(id);
        const res = await this.q<{
          context?: { id: string; name: string; config?: SlConfig[] } | null;
        }>(
          "context variable",
          "query($id: ID!) { context(id: $id) { id name config { id type value writeOnly description checksum } } }",
          { id: contextId },
        );
        const e = res.context?.config?.find((x) => x.id === name);
        if (!res.context || !e)
          throw new SpaceliftApiError(
            404,
            `Spacelift plugin: ${name} not found in context ${contextId}`,
          );
        return mapConfig(accountId, contextId, res.context.name, e);
      }
      case "policy": {
        const res = await this.q<{ policy?: SlPolicy | null }>(
          "policy",
          "query($id: ID!) { policy(id: $id) { id name body type description labels space createdAt updatedAt } }",
          { id },
        );
        if (!res.policy)
          throw new SpaceliftApiError(404, `Spacelift plugin: policy ${id} not found`);
        const attached = await this.soft<{
          policy?: {
            attachedStacks?: Array<{
              id: string;
              stackId: string;
              stackName?: string;
              isModule?: boolean;
            }>;
          };
        }>(
          "policy attachments",
          "query($id: ID!) { policy(id: $id) { attachedStacks { id stackId stackName isModule } } }",
          { id },
        );
        const list = attached?.policy?.attachedStacks;
        const r = mapPolicy(accountId, res.policy);
        return stash(
          list
            ? {
                ...r,
                fields: {
                  ...r.fields,
                  attachedStacks: list.map((a) => a.stackName || a.stackId).join(", "),
                },
              }
            : r,
          { [DETAIL_KEYS.attachments]: list, [DETAIL_KEYS.stacks]: await this.stackOptions() },
        );
      }
      case "module": {
        const res = await this.q<{ module?: SlModule | null }>(
          "module",
          "query($id: ID!) { module(id: $id) { id name namespace repository provider terraformProvider space description labels administrative branch createdAt } }",
          { id },
        );
        if (!res.module)
          throw new SpaceliftApiError(404, `Spacelift plugin: module ${id} not found`);
        return mapModule(accountId, res.module);
      }
      case "worker-pool": {
        const res = await this.q<{ workerPool?: SlWorkerPool | null }>(
          "worker pool",
          "query($id: ID!) { workerPool(id: $id) { id name description labels space createdAt } }",
          { id },
        );
        if (!res.workerPool)
          throw new SpaceliftApiError(404, `Spacelift plugin: worker pool ${id} not found`);
        const workers = (
          await this.soft<{
            workerPool?: {
              workers?: Array<{ id: string; busy?: boolean; drained?: boolean; status?: string }>;
            };
          }>(
            "workers",
            "query($id: ID!) { workerPool(id: $id) { workers { id busy drained status } } }",
            { id },
          )
        )?.workerPool?.workers;
        return stash(
          mapWorkerPool(
            accountId,
            res.workerPool,
            workers ? { workers: workers.length, busy: workers.filter((w) => w.busy).length } : {},
          ),
          { [DETAIL_KEYS.workers]: workers },
        );
      }
      default:
        throw new Error(`Spacelift plugin: unknown resource type "${typeId}"`);
    }
  }

  private async stackDetail(accountId: string, id: string): Promise<ResourceInstance> {
    const res = await this.q<{ stack?: SlStack | null }>(
      "stack",
      `query($id: ID!) { stack(id: $id) { ${STACK_FIELDS} } }`,
      { id },
    );
    if (!res.stack) throw new SpaceliftApiError(404, `Spacelift plugin: stack ${id} not found`);
    const [extra, runs, scheduled] = await Promise.all([
      this.soft<{
        stack?: {
          integrations?: {
            driftDetection?: {
              schedule?: string[];
              timezone?: string;
              reconcile?: boolean;
              ignoreState?: boolean;
            } | null;
          } | null;
          attachedContexts?: Array<{
            contextId: string;
            contextName?: string;
            priority?: number;
            isAutoattached?: boolean;
          }>;
        };
      }>(
        "stack details",
        "query($id: ID!) { stack(id: $id) { integrations { driftDetection { schedule timezone reconcile ignoreState } } attachedContexts { contextId contextName priority isAutoattached } } }",
        { id },
      ),
      this.soft<{ stack?: { runs?: SlRun[] } }>(
        "stack runs",
        `query($id: ID!) { stack(id: $id) { runs(before: null) { ${RUN_FIELDS} } } }`,
        { id },
      ),
      this.soft<{
        stack?: {
          scheduledRuns?: Array<{
            id: string;
            name: string;
            cronSchedule?: string[];
            nextSchedule?: number | null;
          }>;
        };
      }>(
        "scheduled runs",
        "query($id: ID!) { stack(id: $id) { scheduledRuns { id name cronSchedule nextSchedule } } }",
        { id },
      ),
    ]);
    const drift = extra?.stack?.integrations?.driftDetection ?? undefined;
    const r = mapStack(accountId, res.stack, this.stackUrl(id));
    const runRows: RunRow[] = (runs?.stack?.runs ?? []).slice(0, 15).map((x) => ({
      id: x.id,
      ...(x.state ? { state: x.state } : {}),
      ...(x.type ? { type: x.type } : {}),
      title: (x.title || x.commit?.message || "").split("\n")[0] ?? "",
      createdAt: unixIso(x.createdAt),
      ...(x.delta
        ? {
            delta: `${x.delta.addCount ?? 0} / ${x.delta.changeCount ?? 0} / ${x.delta.deleteCount ?? 0}`,
          }
        : {}),
    }));
    return stash(
      drift
        ? { ...r, fields: { ...r.fields, driftSchedule: (drift.schedule ?? []).join(", ") } }
        : r,
      {
        [DETAIL_KEYS.runs]: runRows,
        [DETAIL_KEYS.drift]: drift,
        [DETAIL_KEYS.contexts]: extra?.stack?.attachedContexts?.map((c) => ({
          id: c.contextId,
          name: c.contextName ?? c.contextId,
          ...(c.priority !== undefined ? { priority: c.priority } : {}),
          auto: c.isAutoattached === true,
        })),
        [DETAIL_KEYS.scheduled]: scheduled?.stack?.scheduledRuns?.map((s) => ({
          id: s.id,
          name: s.name,
          cron: (s.cronSchedule ?? []).join(", "),
          next: unixIso(s.nextSchedule),
        })),
      },
    );
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const r = await this.getResource(typeId, resourceId, accountId);
    const v = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    if (v !== undefined) return String(v);
    if (typeId === "stack-output" && outputKey === "value") {
      throw new Error(
        "Spacelift does not return this sensitive output. Turn on uploading sensitive outputs for the stack to reference it.",
      );
    }
    throw new Error(`Spacelift plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, logs, quotas
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId !== "stack") return [];
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const state = String(r.fields["state"] ?? "—");
    return [
      {
        label: "State",
        value: state,
        variant:
          state === "FAILED" ? "status-error" : state === "FINISHED" ? "status-healthy" : "default",
      },
      { label: "Tool", value: String(r.fields["vendor"] ?? "—") },
    ];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "stack") return [];
    const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
    const id = externalIdOf(resourceId);
    const runs: SlRun[] = [];
    let before: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: { stack?: { runs?: SlRun[] } } = await this.q(
        "stack runs",
        `query($id: ID!, $before: ID) { stack(id: $id) { runs(before: $before) { ${RUN_FIELDS} } } }`,
        {
          id,
          before,
        },
      );
      const batch: SlRun[] = res.stack?.runs ?? [];
      runs.push(...batch);
      const last = batch[batch.length - 1];
      if (!last || (last.createdAt ?? 0) * 1000 < range.startMs) break;
      before = last.id;
    }
    return runSeries(runs, range.startMs, range.endMs);
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "run") throw new Error(`Spacelift plugin: no logs for "${typeId}"`);
    const [stackId, runId] = splitFirst(externalIdOf(resourceId));
    const hist = await this.q<{
      stack?: {
        run?: { history?: Array<{ state: string; stateVersion: number; hasLogs: boolean }> } | null;
      } | null;
    }>(
      "run history",
      "query($stack: ID!, $run: ID!) { stack(id: $stack) { run(id: $run) { history { state stateVersion hasLogs terminal timestamp } } } }",
      { stack: stackId, run: runId },
    );
    // History is newest first; logs read best oldest first.
    const phases = [...(hist.stack?.run?.history ?? [])].reverse().filter((h) => h.hasLogs);
    const names = phases.map(
      (p) =>
        `${p.state.toLowerCase()}${phases.filter((x) => x.state === p.state).length > 1 ? ` ${p.stateVersion}` : ""}`,
    );
    const containers = ["all", ...names];
    const active =
      params.container && containers.includes(params.container) ? params.container : "all";
    const wanted = active === "all" ? phases : phases.filter((_, i) => names[i] === active);
    const lines: string[] = [];
    for (const p of wanted) {
      if (active === "all") lines.push(`== ${p.state}`);
      let tokenVar: string | null = null;
      for (let i = 0; i < MAX_LOG_PAGES; i++) {
        const res: {
          stack?: {
            run?: {
              logs?: {
                messages?: Array<{ message?: string }>;
                nextToken?: string | null;
                hasMore?: boolean;
                finished?: boolean;
              };
            };
          };
        } = await this.q(
          "run logs",
          "query($stack: ID!, $run: ID!, $state: RunState!, $token: String, $stateVersion: Int) { stack(id: $stack) { run(id: $run) { logs(state: $state, token: $token, stateVersion: $stateVersion) { exists finished hasMore messages { message } nextToken } } } }",
          {
            stack: stackId,
            run: runId,
            state: p.state,
            token: tokenVar,
            stateVersion: p.stateVersion,
          },
        );
        const logs = res.stack?.run?.logs;
        for (const m of logs?.messages ?? [])
          lines.push(stripAnsi(m.message ?? "").replace(/\n$/, ""));
        if (!logs?.hasMore || !logs.nextToken || logs.nextToken === tokenVar) break;
        tokenVar = logs.nextToken;
      }
    }
    return {
      text: tailLines(lines.join("\n"), Math.max(1, params.tailLines ?? 500)),
      containers,
      activeContainer: active,
    };
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const usage = (
      await this.soft<{ usage?: A }>("usage", "{ usage { allowedMinutes billingPeriodStart } }")
    )?.usage;
    const allowed = usage?.["allowedMinutes"];
    if (typeof allowed !== "number" || allowed <= 0) return [];
    const startRaw = usage?.["billingPeriodStart"];
    const start =
      typeof startRaw === "number"
        ? startRaw
        : typeof startRaw === "string"
          ? Math.floor(Date.parse(startRaw) / 1000)
          : NaN;
    if (!Number.isFinite(start)) return [];
    const minutes = await this.q<{
      runMinutesUsage?: { totals?: { publicMinutes?: number; privateMinutes?: number } };
    }>(
      "runMinutesUsage",
      "query($input: RunMinutesUsageInput!) { runMinutesUsage(input: $input) { totals { publicMinutes privateMinutes } } }",
      { input: { startTime: start, endTime: Math.floor(Date.now() / 1000) } },
    );
    const t = minutes.runMinutesUsage?.totals;
    if (!t) return [];
    return [
      {
        id: "run-minutes",
        service: "Spacelift",
        name: "Run minutes this billing period",
        limit: allowed,
        used: (t.publicMinutes ?? 0) + (t.privateMinutes ?? 0),
        unit: "minutes",
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Policy body editor
  // -------------------------------------------------------------------------

  async getManifest(resourceId: string, accountId: string): Promise<string> {
    if (resourceId.split(":")[1] !== "policy")
      throw new Error("Spacelift plugin: only policies have an editable body");
    const r = await this.getResource("policy", resourceId, accountId);
    return String(r.fields["body"] ?? "");
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    if (resourceId.split(":")[1] !== "policy")
      throw new Error("Spacelift plugin: only policies have an editable body");
    const id = externalIdOf(resourceId);
    const res = await this.q<{ policy?: SlPolicy | null }>(
      "policy",
      "query($id: ID!) { policy(id: $id) { id name description labels space } }",
      { id },
    );
    if (!res.policy) throw new SpaceliftApiError(404, `Spacelift plugin: policy ${id} not found`);
    await this.q(
      "policyUpdatev2",
      "mutation($id: ID!, $input: PolicyUpdateInput!) { policyUpdatev2(id: $id, input: $input) { id } }",
      {
        id,
        input: {
          name: res.policy.name,
          body: manifest,
          description: res.policy.description ?? "",
          labels: res.policy.labels ?? [],
          space: res.policy.space,
        },
      },
    );
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  private async spaceOptions(): Promise<Option[]> {
    const res = await this.soft<{ spaces?: SlSpace[] }>("spaces", "{ spaces { id name } }");
    return (res?.spaces ?? []).map((s) => ({ id: s.id, name: s.name }));
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const spaceField = async (key = "space") => {
      if (parentResourceId && typeId === "stack") return [];
      const spaces = await this.spaceOptions();
      return [
        {
          key,
          label: "Space",
          kind: "select" as const,
          required: true,
          defaultValue: spaces.find((s) => s.id === "root")?.id ?? spaces[0]?.id ?? "root",
          options: spaces.map((s) => ({ id: s.id, label: s.name, description: s.id })),
        },
      ];
    };
    const labelsField = {
      key: "labels",
      label: "Labels",
      kind: "text" as const,
      required: false,
      placeholder: "team:platform, autoattach:aws",
    };
    switch (typeId) {
      case "space":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "production" },
            ...(await spaceField("parentSpace")).map((f) => ({ ...f, label: "Parent space" })),
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "inheritEntities",
              label: "Inherit entities",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                {
                  id: "true",
                  label: "Yes: read access to the parent's contexts, policies and integrations",
                },
              ],
            },
            labelsField,
          ],
        };
      case "stack":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "networking-prod",
            },
            ...(await spaceField()),
            {
              key: "provider",
              label: "VCS",
              kind: "select",
              required: true,
              defaultValue: "GITHUB",
              options: [
                { id: "GITHUB", label: "GitHub" },
                { id: "GITHUB_ENTERPRISE", label: "GitHub (custom app)" },
                { id: "GITLAB", label: "GitLab" },
                { id: "BITBUCKET_CLOUD", label: "Bitbucket Cloud" },
                { id: "BITBUCKET_DATACENTER", label: "Bitbucket Data Center" },
                { id: "AZURE_DEVOPS", label: "Azure DevOps" },
              ],
            },
            {
              key: "namespace",
              label: "Owner / namespace",
              kind: "text",
              required: false,
              placeholder: "acme",
            },
            {
              key: "repository",
              label: "Repository",
              kind: "text",
              required: true,
              placeholder: "infrastructure",
              description: "The repository name, without the owner.",
            },
            { key: "branch", label: "Branch", kind: "text", required: true, defaultValue: "main" },
            {
              key: "projectRoot",
              label: "Project root",
              kind: "text",
              required: false,
              placeholder: "envs/prod",
            },
            {
              key: "tool",
              label: "Tool",
              kind: "select",
              required: true,
              defaultValue: "opentofu",
              options: [
                { id: "opentofu", label: "OpenTofu" },
                { id: "terraform", label: "Terraform" },
                { id: "pulumi", label: "Pulumi" },
                { id: "kubernetes", label: "Kubernetes" },
                { id: "ansible", label: "Ansible" },
              ],
            },
            {
              key: "version",
              label: "Version",
              kind: "text",
              required: false,
              placeholder: "1.9.0",
              showWhen: { fieldKey: "tool", fieldValues: ["opentofu", "terraform"] },
              description: "Leave empty for the latest.",
            },
            {
              key: "pulumiStack",
              label: "Pulumi stack name",
              kind: "text",
              required: true,
              showWhen: { fieldKey: "tool", fieldValue: "pulumi" },
            },
            {
              key: "pulumiLogin",
              label: "Pulumi state backend",
              kind: "text",
              required: true,
              placeholder: "s3://my-pulumi-state",
              showWhen: { fieldKey: "tool", fieldValue: "pulumi" },
            },
            {
              key: "k8sNamespace",
              label: "Kubernetes namespace",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "tool", fieldValue: "kubernetes" },
            },
            {
              key: "playbook",
              label: "Playbook",
              kind: "text",
              required: true,
              placeholder: "site.yml",
              showWhen: { fieldKey: "tool", fieldValue: "ansible" },
            },
            {
              key: "manageState",
              label: "State",
              kind: "select",
              required: true,
              defaultValue: "true",
              showWhen: { fieldKey: "tool", fieldValues: ["opentofu", "terraform"] },
              options: [
                { id: "true", label: "Spacelift manages state" },
                { id: "false", label: "My own backend" },
              ],
            },
            {
              key: "autodeploy",
              label: "Apply",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "After confirmation" },
                { id: "true", label: "Automatically" },
              ],
            },
            { key: "description", label: "Description", kind: "text", required: false },
            labelsField,
          ],
        };
      case "run":
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "stack",
                    label: "Stack",
                    kind: "select" as const,
                    required: true,
                    options: (await this.stackOptions()).map((s) => ({ id: s.id, label: s.name })),
                  },
                ]),
            ...TRIGGER_FIELDS,
          ],
        };
      case "context":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "aws-prod" },
            ...(await spaceField()),
            { key: "description", label: "Description", kind: "text", required: false },
            labelsField,
          ],
        };
      case "context-variable": {
        const contexts = parentResourceId
          ? []
          : ((
              await this.soft<{ contexts?: SlContextItem[] }>(
                "contexts",
                "{ contexts { id name } }",
              )
            )?.contexts ?? []);
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "context",
                    label: "Context",
                    kind: "select" as const,
                    required: true,
                    options: contexts.map((c) => ({ id: c.id, label: c.name })),
                  },
                ]),
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "ENVIRONMENT_VARIABLE",
              options: [
                { id: "ENVIRONMENT_VARIABLE", label: "Environment variable" },
                {
                  id: "FILE_MOUNT",
                  label: "Mounted file",
                  description: "The value is the file's content, base64-encoded.",
                },
              ],
            },
            {
              key: "name",
              label: "Name or path",
              kind: "text",
              required: true,
              placeholder: "AWS_REGION",
            },
            { key: "value", label: "Value", kind: "text", required: false, multiline: true },
            {
              key: "writeOnly",
              label: "Secret",
              kind: "select",
              required: true,
              defaultValue: "true",
              options: [
                { id: "true", label: "Yes: write-only" },
                { id: "false", label: "No: readable" },
              ],
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      }
      case "policy":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "no-weekend-deploys",
            },
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "PLAN",
              options: [
                "PLAN",
                "APPROVAL",
                "TRIGGER",
                "GIT_PUSH",
                "INITIALIZATION",
                "LOGIN",
                "ACCESS",
                "TASK",
                "NOTIFICATION",
              ].map((t) => ({
                id: t,
                label: t.charAt(0) + t.slice(1).toLowerCase().replace("_", " "),
              })),
            },
            ...(await spaceField()),
            {
              key: "body",
              label: "Rego",
              kind: "code",
              codeLanguage: "plaintext",
              required: true,
              defaultValue: "package spacelift\n\n# deny contains msg if { ... }\n",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            labelsField,
          ],
        };
      default:
        throw new Error(`Spacelift plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : undefined;
    const need = (key: string, label: string) => {
      const v = (fields[key] ?? "").trim();
      if (!v) throw new Error(`Spacelift plugin: "${label}" is required`);
      return v;
    };
    const opt = (key: string) => (fields[key] ?? "").trim();
    switch (typeId) {
      case "space": {
        const res = await this.q<{ spaceCreate: SlSpace }>(
          "spaceCreate",
          "mutation($input: SpaceInput!) { spaceCreate(input: $input) { id name description parentSpace inheritEntities labels } }",
          {
            input: {
              name: need("name", "Name"),
              description: opt("description"),
              parentSpace: opt("parentSpace") || "root",
              inheritEntities: bool(fields["inheritEntities"]),
              labels: labelList(fields["labels"]),
            },
          },
        );
        return mapSpace(accountId, res.spaceCreate);
      }
      case "stack": {
        const tool = opt("tool") || "opentofu";
        const version = opt("version");
        const vendorConfig =
          tool === "terraform"
            ? { terraform: { ...(version ? { version } : {}), workflowTool: "TERRAFORM_FOSS" } }
            : tool === "pulumi"
              ? {
                  pulumi: {
                    stackName: need("pulumiStack", "Pulumi stack name"),
                    loginURL: need("pulumiLogin", "Pulumi state backend"),
                  },
                }
              : tool === "kubernetes"
                ? { kubernetes: { namespace: opt("k8sNamespace") } }
                : tool === "ansible"
                  ? { ansible: { playbook: need("playbook", "Playbook") } }
                  : { opentofu: { ...(version ? { version } : {}), workflowTool: "OPEN_TOFU" } };
        const res = await this.q<{ stackCreate: SlStack }>(
          "stackCreate",
          `mutation($input: StackInput!, $manageState: Boolean!) { stackCreate(input: $input, manageState: $manageState) { ${MINIMAL_STACK_FIELDS} } }`,
          {
            input: {
              name: need("name", "Name"),
              space: opt("space") || parent || "root",
              provider: opt("provider") || "GITHUB",
              ...(opt("namespace") ? { namespace: opt("namespace") } : {}),
              repository: need("repository", "Repository"),
              branch: need("branch", "Branch"),
              ...(opt("projectRoot") ? { projectRoot: opt("projectRoot") } : {}),
              administrative: false,
              autodeploy: bool(fields["autodeploy"]),
              ...(opt("description") ? { description: opt("description") } : {}),
              labels: labelList(fields["labels"]),
              vendorConfig,
            },
            manageState:
              (tool === "terraform" || tool === "opentofu") && fields["manageState"] !== "false",
          },
        );
        this.stacksCache = undefined;
        return mapStack(accountId, res.stackCreate, this.stackUrl(res.stackCreate.id));
      }
      case "run": {
        const stack = opt("stack") || parent || need("stack", "Stack");
        const res = await this.q<{ runTrigger: SlRun }>(
          "runTrigger",
          `mutation($stack: ID!, $commitSha: String, $runType: RunType) { runTrigger(stack: $stack, commitSha: $commitSha, runType: $runType) { ${RUN_FIELDS} } }`,
          { stack, commitSha: opt("commitSha") || null, runType: opt("runType") || "TRACKED" },
        );
        const name =
          (await this.stacks().catch(() => [] as SlStack[])).find((s) => s.id === stack)?.name ??
          stack;
        return mapRun(
          accountId,
          stack,
          name,
          res.runTrigger,
          this.runUrl(stack, res.runTrigger.id),
        );
      }
      case "context": {
        const res = await this.q<{ contextCreateV2: SlContextItem }>(
          "contextCreateV2",
          "mutation($input: ContextInput!) { contextCreateV2(input: $input) { id name description labels space } }",
          {
            input: {
              name: need("name", "Name"),
              description: opt("description"),
              labels: labelList(fields["labels"]),
              space: opt("space") || "root",
            },
          },
        );
        return mapContext(accountId, res.contextCreateV2, { variableCount: 0 });
      }
      case "context-variable": {
        const context = opt("context") || parent || need("context", "Context");
        const res = await this.q<{ contextConfigAdd: SlConfig }>(
          "contextConfigAdd",
          "mutation($context: ID!, $config: ConfigInput!) { contextConfigAdd(context: $context, config: $config) { id type value writeOnly description checksum } }",
          {
            context,
            config: {
              id: need("name", "Name"),
              type: opt("type") || "ENVIRONMENT_VARIABLE",
              value: fields["value"] ?? "",
              writeOnly: fields["writeOnly"] !== "false",
              description: opt("description") || null,
            },
          },
        );
        return mapConfig(accountId, context, context, res.contextConfigAdd);
      }
      case "policy": {
        const res = await this.q<{ policyCreatev2: SlPolicy }>(
          "policyCreatev2",
          "mutation($input: PolicyCreateInput!) { policyCreatev2(input: $input) { id name body type description labels space } }",
          {
            input: {
              name: need("name", "Name"),
              body: need("body", "Rego"),
              type: opt("type") || "PLAN",
              description: opt("description"),
              labels: labelList(fields["labels"]),
              space: opt("space") || "root",
            },
          },
        );
        return mapPolicy(accountId, res.policyCreatev2);
      }
      default:
        throw new Error(`Spacelift plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const has = (k: string) => k in fields;
    const text = (k: string) => (fields[k] ?? "").trim();
    switch (typeId) {
      case "space": {
        const cur = await this.getResource(typeId, resourceId, accountId);
        await this.q(
          "spaceUpdate",
          "mutation($space: ID!, $input: SpaceInput!) { spaceUpdate(space: $space, input: $input) { id } }",
          {
            space: id,
            input: {
              name: has("name") ? text("name") : cur.fields["name"],
              description: has("description")
                ? text("description")
                : (cur.fields["description"] ?? ""),
              parentSpace: cur.fields["parentSpace"] || "root",
              inheritEntities: has("inheritEntities")
                ? bool(fields["inheritEntities"])
                : cur.fields["inheritEntities"] === true,
              labels: labelList(
                has("labels") ? fields["labels"] : String(cur.fields["labels"] ?? ""),
              ),
            },
          },
        );
        return this.getResource(typeId, resourceId, accountId);
      }
      case "stack": {
        const res = await this.q<{ stack?: A | null }>(
          "stack",
          `query($id: ID!) { stack(id: $id) { ${STACK_UPDATE_FIELDS} } }`,
          { id },
        );
        if (!res.stack) throw new SpaceliftApiError(404, `Spacelift plugin: stack ${id} not found`);
        await this.q(
          "stackUpdate",
          "mutation($id: ID!, $input: StackInput!) { stackUpdate(id: $id, input: $input) { id } }",
          {
            id,
            input: stackUpdateInput(res.stack, fields),
          },
        );
        this.stacksCache = undefined;
        return this.getResource(typeId, resourceId, accountId);
      }
      case "context": {
        const res = await this.q<{ context?: (SlContextItem & { hooks?: A }) | null }>(
          "context",
          `query($id: ID!) { context(id: $id) { id name description labels space hooks { ${HOOK_FIELDS} } } }`,
          { id },
        );
        if (!res.context)
          throw new SpaceliftApiError(404, `Spacelift plugin: context ${id} not found`);
        const c = res.context;
        await this.q(
          "contextUpdateV2",
          "mutation($id: ID!, $input: ContextInput!) { contextUpdateV2(id: $id, input: $input) { id } }",
          {
            id,
            input: {
              name: has("name") ? text("name") : c.name,
              description: has("description") ? text("description") : (c.description ?? ""),
              labels: has("labels") ? labelList(fields["labels"]) : (c.labels ?? []),
              space: c.space,
              ...(c.hooks ? { hooks: c.hooks } : {}),
            },
          },
        );
        return this.getResource(typeId, resourceId, accountId);
      }
      case "context-variable": {
        const [contextId, name] = splitFirst(id);
        const cur = await this.getResource(typeId, resourceId, accountId);
        const secret = cur.fields["writeOnly"] === true;
        if (secret && !fields["value"] && !has("description")) return cur;
        if (secret && !fields["value"]) {
          throw new Error(
            "Spacelift plugin: a secret's value cannot be read back, so type the value again to change its description",
          );
        }
        await this.q(
          "contextConfigAdd",
          "mutation($context: ID!, $config: ConfigInput!) { contextConfigAdd(context: $context, config: $config) { id } }",
          {
            context: contextId,
            config: {
              id: name,
              type: cur.fields["type"] === "file" ? "FILE_MOUNT" : "ENVIRONMENT_VARIABLE",
              value:
                "value" in fields && (fields["value"] || !secret)
                  ? (fields["value"] ?? "")
                  : String(cur.fields["value"] ?? ""),
              writeOnly: secret,
              description: has("description")
                ? text("description") || null
                : cur.fields["description"] || null,
            },
          },
        );
        return this.getResource(typeId, resourceId, accountId);
      }
      case "policy": {
        const res = await this.q<{ policy?: SlPolicy | null }>(
          "policy",
          "query($id: ID!) { policy(id: $id) { id name body description labels space } }",
          { id },
        );
        if (!res.policy)
          throw new SpaceliftApiError(404, `Spacelift plugin: policy ${id} not found`);
        const p = res.policy;
        await this.q(
          "policyUpdatev2",
          "mutation($id: ID!, $input: PolicyUpdateInput!) { policyUpdatev2(id: $id, input: $input) { id } }",
          {
            id,
            input: {
              name: has("name") ? text("name") : p.name,
              body: p.body ?? "",
              description: has("description") ? text("description") : (p.description ?? ""),
              labels: has("labels") ? labelList(fields["labels"]) : (p.labels ?? []),
              space: p.space,
            },
          },
        );
        return this.getResource(typeId, resourceId, accountId);
      }
      case "module": {
        const cur = await this.q<{
          module?: (SlModule & { workerPool?: { id?: string } | null }) | null;
        }>(
          "module",
          "query($id: ID!) { module(id: $id) { id administrative branch description labels space workerPool { id } } }",
          { id },
        );
        if (!cur.module)
          throw new SpaceliftApiError(404, `Spacelift plugin: module ${id} not found`);
        const m = cur.module;
        await this.q(
          "moduleUpdate",
          "mutation($id: ID!, $input: ModuleUpdateInput!) { moduleUpdate(id: $id, input: $input) { id } }",
          {
            id,
            input: {
              administrative: m.administrative ?? false,
              branch: has("branch") ? text("branch") : m.branch,
              description: has("description") ? text("description") : (m.description ?? ""),
              labels: has("labels") ? labelList(fields["labels"]) : (m.labels ?? []),
              space: m.space,
              workerPool: m.workerPool?.id ?? null,
            },
          },
        );
        return this.getResource(typeId, resourceId, accountId);
      }
      case "worker-pool": {
        const cur = await this.getResource(typeId, resourceId, accountId);
        await this.q(
          "workerPoolUpdate",
          "mutation($id: ID!, $name: String!, $description: String, $labels: [String!], $space: ID) { workerPoolUpdate(id: $id, name: $name, description: $description, labels: $labels, space: $space) { id } }",
          {
            id,
            name: has("name") ? text("name") : cur.fields["name"],
            description: has("description")
              ? text("description")
              : (cur.fields["description"] ?? ""),
            labels: labelList(
              has("labels") ? fields["labels"] : String(cur.fields["labels"] ?? ""),
            ),
            space: cur.fields["space"] ?? null,
          },
        );
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Spacelift plugin: cannot edit "${typeId}" from Infrawrench`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "space":
        await this.q("spaceDelete", "mutation($space: ID!) { spaceDelete(space: $space) { id } }", {
          space: id,
        });
        return;
      case "stack":
        // Never destroyResources: deleting the stack must not tear down infrastructure.
        await this.q("stackDelete", "mutation($id: ID!) { stackDelete(id: $id) { id } }", { id });
        this.stacksCache = undefined;
        return;
      case "context":
        await this.q("contextDelete", "mutation($id: ID!) { contextDelete(id: $id) { id } }", {
          id,
        });
        return;
      case "context-variable": {
        const [context, name] = splitFirst(id);
        await this.q(
          "contextConfigDelete",
          "mutation($context: ID!, $id: ID!) { contextConfigDelete(context: $context, id: $id) { id } }",
          {
            context,
            id: name,
          },
        );
        return;
      }
      case "policy":
        await this.q("policyDelete", "mutation($id: ID!) { policyDelete(id: $id) { id } }", { id });
        return;
      case "module":
        await this.q("moduleDelete", "mutation($id: ID!) { moduleDelete(id: $id) { id } }", { id });
        return;
      case "worker-pool":
        await this.q(
          "workerPoolDelete",
          "mutation($id: ID!) { workerPoolDelete(id: $id) { id } }",
          { id },
        );
        return;
      default:
        throw new Error(`Spacelift plugin: cannot delete "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    const [verb, arg] = actionId.split(":");
    if (typeId === "stack") {
      switch (verb) {
        case "unlock":
          await this.q("stackUnlock", "mutation($id: ID!) { stackUnlock(id: $id) { id } }", { id });
          return;
        case "enable":
        case "disable":
          await this.q(
            verb === "enable" ? "stackEnable" : "stackDisable",
            `mutation($id: ID!) { stack${verb === "enable" ? "Enable" : "Disable"}(id: $id) { id } }`,
            { id },
          );
          return;
        case "drift-off":
          await this.q(
            "stackIntegrationDriftDetectionDelete",
            "mutation($stack: ID!) { stackIntegrationDriftDetectionDelete(stack: $stack) { deleted } }",
            { stack: id },
          );
          return;
        case "scheduled-delete":
          await this.q(
            "stackScheduledRunDelete",
            "mutation($stack: ID!, $scheduledRun: ID!) { stackScheduledRunDelete(stack: $stack, scheduledRun: $scheduledRun) { id } }",
            { stack: id, scheduledRun: arg },
          );
          return;
      }
    }
    if (typeId === "run") {
      const [stack, run] = splitFirst(id);
      const simple: Record<string, string> = {
        confirm: "runConfirm",
        discard: "runDiscard",
        cancel: "runCancel",
        retry: "runRetry",
      };
      if (simple[actionId]) {
        const m = simple[actionId]!;
        await this.q(
          m,
          `mutation($stack: ID!, $run: ID!) { ${m}(stack: $stack, run: $run) { id } }`,
          { stack, run },
        );
        return;
      }
      if (actionId === "stop") {
        await this.q(
          "runStop",
          "mutation($stack: ID!, $run: ID!, $note: String) { runStop(stack: $stack, run: $run, note: $note) { id } }",
          {
            stack,
            run,
            note: "Stopped from Infrawrench",
          },
        );
        return;
      }
    }
    if ((typeId === "context" || typeId === "policy") && verb === "detach" && arg) {
      const m = typeId === "context" ? "contextDetach" : "policyDetach";
      await this.q(m, `mutation($id: ID!) { ${m}(id: $id) { id } }`, { id: arg });
      return;
    }
    if (typeId === "module" && (actionId === "enable" || actionId === "disable")) {
      const m = actionId === "enable" ? "moduleEnable" : "moduleDisable";
      await this.q(m, `mutation($id: ID!) { ${m}(id: $id) { id } }`, { id });
      return;
    }
    if (typeId === "worker-pool") {
      if (actionId === "cycle") {
        await this.q("workerPoolCycle", "mutation($id: ID!) { workerPoolCycle(id: $id) }", { id });
        return;
      }
      if ((verb === "drain" || verb === "undrain") && arg) {
        await this.q(
          "workerDrainSet",
          "mutation($workerPool: ID!, $id: ID!, $drain: Boolean!) { workerDrainSet(workerPool: $workerPool, id: $id, drain: $drain) { id } }",
          {
            workerPool: id,
            id: arg,
            drain: verb === "drain",
          },
        );
        return;
      }
    }
    throw new Error(`Spacelift plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const id = externalIdOf(resourceId);
    const vals = parseFormArg(args[0]);
    switch (command) {
      case "trigger":
        if (typeId !== "stack") break;
        await this.q(
          "runTrigger",
          "mutation($stack: ID!, $commitSha: String, $runType: RunType) { runTrigger(stack: $stack, commitSha: $commitSha, runType: $runType) { id } }",
          {
            stack: id,
            commitSha: (vals["commitSha"] ?? "").trim() || null,
            runType: vals["runType"] || "TRACKED",
          },
        );
        return null;
      case "lock":
        if (typeId !== "stack") break;
        await this.q(
          "stackLock",
          "mutation($id: ID!, $note: String) { stackLock(id: $id, note: $note) { id } }",
          {
            id,
            note: (vals["note"] ?? "").trim() || null,
          },
        );
        return null;
      case "drift": {
        if (typeId !== "stack") break;
        const schedule = labelList(vals["schedule"]);
        if (schedule.length === 0)
          throw new Error("Spacelift plugin: give at least one cron schedule");
        const input = {
          schedule,
          timezone: (vals["timezone"] ?? "").trim() || "UTC",
          reconcile: vals["reconcile"] === "true",
          ignoreState: vals["ignoreState"] === "true",
        };
        try {
          await this.q(
            "stackIntegrationDriftDetectionUpdate",
            "mutation($stack: ID!, $input: DriftDetectionIntegrationInput!) { stackIntegrationDriftDetectionUpdate(stack: $stack, input: $input) { reconcile } }",
            { stack: id, input },
          );
        } catch {
          await this.q(
            "stackIntegrationDriftDetectionCreate",
            "mutation($stack: ID!, $input: DriftDetectionIntegrationInput!) { stackIntegrationDriftDetectionCreate(stack: $stack, input: $input) { reconcile } }",
            { stack: id, input },
          );
        }
        return null;
      }
      case "scheduleRun":
        if (typeId !== "stack") break;
        await this.q(
          "stackScheduledRunCreate",
          "mutation($stack: ID!, $input: ScheduledRunInput!) { stackScheduledRunCreate(stack: $stack, input: $input) { id } }",
          {
            stack: id,
            input: {
              name: (vals["name"] ?? "").trim() || "Scheduled run",
              cronSchedule: labelList(vals["cron"]),
              timezone: (vals["timezone"] ?? "").trim() || "UTC",
            },
          },
        );
        return null;
      case "attach": {
        if (typeId !== "context" && typeId !== "policy") break;
        if (!vals["stack"]) throw new Error("Spacelift plugin: choose a stack");
        if (typeId === "context") {
          await this.q(
            "contextAttach",
            "mutation($id: ID!, $stack: ID!, $priority: Int!) { contextAttach(id: $id, stack: $stack, priority: $priority) { id } }",
            {
              id,
              stack: vals["stack"],
              priority: Number(vals["priority"] || "0") || 0,
            },
          );
        } else {
          await this.q(
            "policyAttach",
            "mutation($id: ID!, $stack: ID!) { policyAttach(id: $id, stack: $stack) { id } }",
            { id, stack: vals["stack"] },
          );
        }
        return null;
      }
    }
    throw new Error(`Spacelift plugin: unknown command "${command}" for "${typeId}"`);
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "stack" || formatId !== "state")
      throw new Error(`Spacelift plugin: cannot export "${formatId}" for "${typeId}"`);
    const id = externalIdOf(resourceId);
    const res = await this.q<{ stateDownloadUrl?: { url?: string } | null }>(
      "stateDownloadUrl",
      "mutation($input: StateDownloadUrlInput!) { stateDownloadUrl(input: $input) { url } }",
      { input: { stackId: id } },
    );
    const url = res.stateDownloadUrl?.url;
    if (!url)
      throw new Error(
        "Spacelift did not return a state download URL. Only stacks whose state Spacelift manages have one.",
      );
    let content: string;
    if (this.ctx.http) {
      const r = await this.ctx.http.request({ url, method: "GET", headers: {} });
      if (r.status < 200 || r.status >= 300)
        throw new SpaceliftApiError(r.status, `State download failed (${r.status})`);
      content = r.body;
    } else {
      const r = await fetch(url);
      if (!r.ok) throw new SpaceliftApiError(r.status, `State download failed (${r.status})`);
      content = await r.text();
    }
    return {
      content,
      filename: `${id}.tfstate`,
      mimeType: "application/json",
      warning:
        "State files can contain secrets in plain text. Store this file as carefully as the credentials it may hold.",
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderSpaceliftDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSpaceliftSidebar(resource);
  }
}
