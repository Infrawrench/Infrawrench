import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
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
  ResourceCreateReturn,
  ResourceInstance,
  SecretHostServices,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { QuotaAccessError, externalIdOf } from "@infrawrench/plugin-base";
import type { Doc, Page, TfContext } from "./api.js";
import {
  DEFAULT_HOSTNAME,
  appUrl,
  cleanTerraformLog,
  doc,
  enc,
  normaliseHostname,
  relId,
  TfApiError,
  statusOf,
  tfCount,
  tfGet,
  tfList,
  tfRaw,
  tfWrite,
} from "./api.js";
import { fetchInvoiceCost } from "./cost.js";
import type { WorkspaceHealth } from "./mappers.js";
import {
  TEAM_ACCESS_FLAGS,
  camel,
  healthFromExplorer,
  mapAgent,
  mapAgentPool,
  mapAgentToken,
  mapOrganization,
  mapOutput,
  mapPolicySet,
  mapProject,
  mapRegistryModule,
  mapRegistryProvider,
  mapRun,
  mapRunTask,
  mapTeam,
  mapVariable,
  mapVarset,
  mapVarsetVariable,
  mapWorkspace,
  outputText,
  s,
  splitFirst,
} from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, rangeOrDefault, runMetrics } from "./metrics.js";
import type { Option, RunRow, StateVersionRow } from "./render.js";
import {
  DETAIL_KEYS,
  RUN_EXTRA_FIELDS,
  RUN_KIND_FIELD,
  renderTfDetail,
  renderTfSidebar,
} from "./render.js";

type A = Record<string, unknown>;

/** Runs listed: the most recent across the organization. */
const RUN_LIMIT = 50;
const MAX_LOG_LINES = 5000;

const bool = (v: string | undefined) => v === "true" || v === "1";

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

const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** The attributes of a `POST /runs` body for a run kind picked in a form. */
export function runAttributes(fields: Record<string, string>): Record<string, unknown> {
  const kind = fields["kind"] || "plan-and-apply";
  const message = (fields["message"] ?? "").trim() || "Queued from Infrawrench";
  const targets = list(fields["targets"]);
  const replace = list(fields["replace"]);
  return {
    message,
    ...(kind === "plan-only" ? { "plan-only": true } : {}),
    ...(kind === "refresh-only" ? { "refresh-only": true } : {}),
    ...(kind === "destroy" ? { "is-destroy": true } : {}),
    ...(targets.length > 0 ? { "target-addrs": targets } : {}),
    ...(replace.length > 0 ? { "replace-addrs": replace } : {}),
  };
}

/** Last `n` lines of a text. */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + (lines.length > 0 ? "\n" : "");
}

export class HcpTerraformClient implements PluginClient {
  private readonly ctx: TfContext;
  private readonly org: string;
  private readonly secrets: SecretHostServices | undefined;
  private orgCache: Promise<Doc<A>> | undefined;
  private workspacesCache: Promise<Page<A>> | undefined;
  private projectsCache: Promise<Doc<A>[]> | undefined;
  private healthCache: Promise<Map<string, WorkspaceHealth> | undefined> | undefined;
  private poolsCache: Promise<Doc<A>[]> | undefined;
  private varsetsCache: Promise<Doc<A>[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("HCP Terraform plugin: missing apiToken credential");
    this.org = (credentials["organization"] ?? "").trim();
    if (!this.org) throw new Error("HCP Terraform plugin: pick an organization");
    const caCert = (credentials["caCert"] ?? "").trim();
    this.ctx = {
      token,
      hostname: normaliseHostname(credentials["hostname"] || DEFAULT_HOSTNAME),
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
    this.secrets = services?.secrets;
  }

  setSleep(sleep: (ms: number) => Promise<void>): void {
    this.ctx.sleep = sleep;
  }

  private get base(): string {
    return `/organizations/${enc(this.org)}`;
  }

  private url(path: string): string {
    return appUrl(this.ctx, `${this.org}/${path}`);
  }

  private memo<T>(
    get: () => Promise<T> | undefined,
    set: (p: Promise<T> | undefined) => void,
    load: () => Promise<T>,
  ) {
    let p = get();
    if (!p) {
      p = load().catch((err: unknown) => {
        set(undefined);
        throw err;
      });
      set(p);
    }
    return p;
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  private organization(): Promise<Doc<A>> {
    return this.memo(
      () => this.orgCache,
      (p) => (this.orgCache = p),
      async () => {
        try {
          return (await tfGet<A>(this.ctx, this.base)).data;
        } catch (err) {
          if (statusOf(err) === 404) {
            throw new TfApiError(
              404,
              `HCP Terraform plugin: organization "${this.org}" was not found on ${this.ctx.hostname}, or the token cannot see it. Pick the organization again under Edit credentials.`,
            );
          }
          throw err;
        }
      },
    );
  }

  private workspaces(): Promise<Page<A>> {
    return this.memo(
      () => this.workspacesCache,
      (p) => (this.workspacesCache = p),
      () => tfList<A>(this.ctx, `${this.base}/workspaces`, { include: "current_run,project" }),
    );
  }

  private projects(): Promise<Doc<A>[]> {
    return this.memo(
      () => this.projectsCache,
      (p) => (this.projectsCache = p),
      async () => (await tfList<A>(this.ctx, `${this.base}/projects`)).data,
    );
  }

  /** Drift, checks and RUM per workspace id, from the explorer. Undefined where it is unavailable. */
  private health(): Promise<Map<string, WorkspaceHealth> | undefined> {
    return this.memo(
      () => this.healthCache,
      (p) => (this.healthCache = p),
      async () => {
        try {
          const page = await tfList<A>(
            this.ctx,
            `${this.base}/explorer`,
            { type: "workspaces" },
            10,
          );
          const out = new Map<string, WorkspaceHealth>();
          for (const row of page.data) {
            const id = s(row.attributes["external-id"]) || row.id;
            out.set(id, healthFromExplorer(row.attributes));
          }
          return out;
        } catch {
          // Explorer is restricted to owners / read-all teams and to newer
          // Terraform Enterprise releases; the rest of the plugin works without it.
          return undefined;
        }
      },
    );
  }

  private pools(): Promise<Doc<A>[]> {
    return this.memo(
      () => this.poolsCache,
      (p) => (this.poolsCache = p),
      async () => {
        try {
          return (await tfList<A>(this.ctx, `${this.base}/agent-pools`)).data;
        } catch (err) {
          if (statusOf(err) === 404 || statusOf(err) === 403) return [];
          throw err;
        }
      },
    );
  }

  private varsets(): Promise<Doc<A>[]> {
    return this.memo(
      () => this.varsetsCache,
      (p) => (this.varsetsCache = p),
      async () => (await tfList<A>(this.ctx, `${this.base}/varsets`)).data,
    );
  }

  private async workspaceOptions(): Promise<Option[]> {
    const ws = await this.workspaces().catch(() => ({ data: [], included: [] }) as Page<A>);
    return ws.data
      .map((w) => ({ id: w.id, name: s(w.attributes["name"]) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async projectOptions(): Promise<Option[]> {
    const ps = await this.projects().catch(() => [] as Doc<A>[]);
    return ps
      .map((p) => ({ id: p.id, name: s(p.attributes["name"]) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every item of `fetch` for each workspace, skipping workspaces that refuse. */
  private async perWorkspace(
    fn: (w: Doc<A>) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const w of (await this.workspaces()).data) {
      try {
        out.push(...(await fn(w)));
      } catch (err) {
        const st = statusOf(err);
        if (st !== 403 && st !== 404) throw err;
      }
    }
    return out;
  }

  private workspaceDoc(
    accountId: string,
    w: Doc<A>,
    included: Doc[],
    health?: Map<string, WorkspaceHealth>,
  ) {
    const runId = relId(w, "current-run");
    const run = runId ? included.find((d) => d.type === "runs" && d.id === runId) : undefined;
    const projectId = relId(w, "project");
    const project = projectId
      ? included.find((d) => d.type === "projects" && d.id === projectId)
      : undefined;
    return mapWorkspace(accountId, this.org, w, this.url(`workspaces/${s(w.attributes["name"])}`), {
      projectName: project ? s((project.attributes as A)["name"]) : undefined,
      runStatus: run ? s((run.attributes as A)["status"]) : undefined,
      health: health?.get(w.id),
    });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization":
        return [await this.organizationResource(accountId)];
      case "project": {
        this.projectsCache = undefined;
        const [projects, ws] = await Promise.all([
          this.projects(),
          this.workspaces().catch(() => undefined),
        ]);
        return projects.map((p) =>
          mapProject(
            accountId,
            this.org,
            p,
            this.url(`projects/${p.id}`),
            ws ? ws.data.filter((w) => relId(w, "project") === p.id).length : undefined,
          ),
        );
      }
      case "workspace": {
        this.workspacesCache = undefined;
        this.healthCache = undefined;
        const [ws, health] = await Promise.all([this.workspaces(), this.health()]);
        return ws.data.map((w) => this.workspaceDoc(accountId, w, ws.included, health));
      }
      case "run":
        return this.recentRuns(accountId);
      case "variable":
        return this.perWorkspace(async (w) =>
          (await tfList<A>(this.ctx, `/workspaces/${enc(w.id)}/vars`)).data.map((v) =>
            mapVariable(accountId, w.id, s(w.attributes["name"]), v),
          ),
        );
      case "state-output":
        return this.perWorkspace(async (w) =>
          (
            await tfList<A>(this.ctx, `/workspaces/${enc(w.id)}/current-state-version-outputs`)
          ).data.map((o) => mapOutput(accountId, w.id, s(w.attributes["name"]), o)),
        );
      case "variable-set":
        this.varsetsCache = undefined;
        return (await this.varsets()).map((v) => mapVarset(accountId, this.org, v));
      case "varset-variable": {
        const out: ResourceInstance[] = [];
        for (const vs of await this.varsets()) {
          const vars = await tfList<A>(this.ctx, `/varsets/${enc(vs.id)}/relationships/vars`).catch(
            () => undefined,
          );
          out.push(
            ...(vars?.data ?? []).map((v) =>
              mapVarsetVariable(accountId, vs.id, s(vs.attributes["name"]), v),
            ),
          );
        }
        return out;
      }
      case "agent-pool":
        this.poolsCache = undefined;
        return (await this.pools()).map((p) => mapAgentPool(accountId, this.org, p));
      case "agent": {
        const out: ResourceInstance[] = [];
        for (const p of await this.pools()) {
          const agents = await tfList<A>(this.ctx, `/agent-pools/${enc(p.id)}/agents`).catch(
            () => undefined,
          );
          out.push(
            ...(agents?.data ?? []).map((a) =>
              mapAgent(accountId, p.id, s(p.attributes["name"]), a),
            ),
          );
        }
        return out;
      }
      case "agent-token": {
        const out: ResourceInstance[] = [];
        for (const p of await this.pools()) {
          const tokens = await tfList<A>(
            this.ctx,
            `/agent-pools/${enc(p.id)}/authentication-tokens`,
          ).catch(() => undefined);
          out.push(
            ...(tokens?.data ?? []).map((t) =>
              mapAgentToken(accountId, p.id, s(p.attributes["name"]), t),
            ),
          );
        }
        return out;
      }
      case "policy-set":
        return this.orgList(`${this.base}/policy-sets`, (d) =>
          mapPolicySet(accountId, this.org, d),
        );
      case "team":
        return this.orgList(`${this.base}/teams`, (d) => mapTeam(accountId, this.org, d));
      case "run-task":
        return this.orgList(`${this.base}/tasks`, (d) => mapRunTask(accountId, this.org, d));
      case "registry-module":
        return this.orgList(`${this.base}/registry-modules`, (d) =>
          mapRegistryModule(accountId, this.org, d),
        );
      case "registry-provider":
        return this.orgList(`${this.base}/registry-providers`, (d) =>
          mapRegistryProvider(accountId, this.org, d),
        );
      default:
        throw new Error(`HCP Terraform plugin: unknown resource type "${typeId}"`);
    }
  }

  /** An organization list that answers 404 when the feature is not in the plan. */
  private async orgList(
    path: string,
    map: (d: Doc<A>) => ResourceInstance,
  ): Promise<ResourceInstance[]> {
    try {
      return (await tfList<A>(this.ctx, path)).data.map(map);
    } catch (err) {
      if (statusOf(err) === 404 || statusOf(err) === 403) return [];
      throw err;
    }
  }

  private async recentRuns(accountId: string): Promise<ResourceInstance[]> {
    const names = new Map(
      (await this.workspaces()).data.map((w) => [w.id, s(w.attributes["name"])]),
    );
    try {
      const res = JSON.parse(
        await tfRaw(this.ctx, `${this.base}/runs`, {
          query: { include: "plan", "page[size]": RUN_LIMIT },
        }),
      ) as { data?: Doc<A>[]; included?: Doc<A>[] };
      const plans = new Map(
        (res.included ?? []).filter((d) => d.type === "plans").map((d) => [d.id, d]),
      );
      return (res.data ?? []).map((r) => this.runDoc(accountId, r, names, plans));
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
    // Older Terraform Enterprise releases have no organization run list:
    // read the latest runs of the most recently changed workspaces instead.
    const ws = [...(await this.workspaces()).data]
      .sort((a, b) =>
        s(b.attributes["latest-change-at"]).localeCompare(s(a.attributes["latest-change-at"])),
      )
      .slice(0, 20);
    const out: ResourceInstance[] = [];
    for (const w of ws) {
      const res = await tfList<A>(
        this.ctx,
        `/workspaces/${enc(w.id)}/runs`,
        { include: "plan", "page[size]": 5 },
        1,
      ).catch(() => undefined);
      const plans = new Map(
        (res?.included ?? []).filter((d) => d.type === "plans").map((d) => [d.id, d as Doc<A>]),
      );
      out.push(...(res?.data ?? []).map((r) => this.runDoc(accountId, r, names, plans)));
    }
    return out
      .sort((a, b) => String(b.fields["createdAt"]).localeCompare(String(a.fields["createdAt"])))
      .slice(0, RUN_LIMIT);
  }

  private runDoc(
    accountId: string,
    r: Doc<A>,
    names: Map<string, string>,
    plans: Map<string, Doc<A>>,
  ) {
    const wsId = relId(r, "workspace");
    const wsName = wsId ? names.get(wsId) : undefined;
    const planId = relId(r, "plan");
    return mapRun(
      accountId,
      r,
      wsId ? { id: wsId, name: wsName ?? wsId } : undefined,
      planId ? plans.get(planId) : undefined,
      this.url(`workspaces/${wsName ?? ""}/runs/${r.id}`),
    );
  }

  private async organizationResource(accountId: string): Promise<ResourceInstance> {
    const [org, ws, projects, health, ent, members, next, active] = await Promise.all([
      this.organization(),
      this.workspaces().catch(() => undefined),
      this.projects().catch(() => undefined),
      this.health(),
      tfGet<A>(this.ctx, `${this.base}/entitlement-set`).catch(() => undefined),
      tfCount(this.ctx, `${this.base}/organization-memberships`).catch(() => undefined),
      tfGet<A>(this.ctx, `${this.base}/invoices/next`).catch(() => undefined),
      tfCount(this.ctx, `${this.base}/runs`, { "filter[status_group]": "non_final" }).catch(
        () => undefined,
      ),
    ]);
    const healthRows = health ? [...health.values()] : undefined;
    const limit = ent?.data.attributes["user-limit"];
    const nextTotal = next?.data.attributes["total"];
    const r = mapOrganization(accountId, org, appUrl(this.ctx, `${this.org}/workspaces`), {
      workspaceCount: ws?.total ?? ws?.data.length,
      projectCount: projects?.length,
      rumCount: healthRows ? healthRows.reduce((sum, h) => sum + (h.rumCount ?? 0), 0) : undefined,
      driftedWorkspaces: healthRows ? healthRows.filter((h) => h.drifted).length : undefined,
      checksFailing: healthRows
        ? healthRows.filter((h) => (h.checksFailed ?? 0) + (h.checksErrored ?? 0) > 0).length
        : undefined,
      userCount: members,
      userLimit: typeof limit === "number" ? limit : undefined,
      nextInvoiceTotal: typeof nextTotal === "number" ? nextTotal / 100 : undefined,
      runningRuns: active,
    });
    return stash(r, {
      [DETAIL_KEYS.entitlements]: ent?.data.attributes,
      [DETAIL_KEYS.nextInvoice]:
        typeof nextTotal === "number"
          ? { total: nextTotal, createdAt: next?.data.attributes["created-at"] }
          : undefined,
    });
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
      case "organization":
        return this.organizationResource(accountId);
      case "project": {
        const p = (await tfGet<A>(this.ctx, `/projects/${enc(id)}`)).data;
        const count = await tfCount(this.ctx, `${this.base}/workspaces`, {
          "filter[project][id]": id,
        }).catch(() => undefined);
        return mapProject(accountId, this.org, p, this.url(`projects/${p.id}`), count);
      }
      case "workspace":
        return this.workspaceDetail(accountId, id);
      case "run": {
        const res = await tfGet<A>(this.ctx, `/runs/${enc(id)}`, { include: "plan,workspace" });
        const ws = (res.included ?? []).find((d) => d.type === "workspaces");
        const plan = (res.included ?? []).find((d) => d.type === "plans") as Doc<A> | undefined;
        const wsName = ws ? s((ws.attributes as A)["name"]) : undefined;
        const wsId = relId(res.data, "workspace");
        return mapRun(
          accountId,
          res.data,
          wsId ? { id: wsId, name: wsName ?? wsId } : undefined,
          plan,
          this.url(`workspaces/${wsName ?? ""}/runs/${res.data.id}`),
        );
      }
      case "variable": {
        const [wsId, varId] = splitFirst(id);
        const [vars, ws] = await Promise.all([
          tfList<A>(this.ctx, `/workspaces/${enc(wsId)}/vars`),
          tfGet<A>(this.ctx, `/workspaces/${enc(wsId)}`),
        ]);
        const v = vars.data.find((x) => x.id === varId);
        if (!v) throw new TfApiError(404, `HCP Terraform plugin: variable ${varId} not found`);
        return mapVariable(accountId, wsId, s(ws.data.attributes["name"]), v);
      }
      case "state-output": {
        const [wsId, name] = splitFirst(id);
        const [outs, ws] = await Promise.all([
          tfList<A>(this.ctx, `/workspaces/${enc(wsId)}/current-state-version-outputs`),
          tfGet<A>(this.ctx, `/workspaces/${enc(wsId)}`),
        ]);
        const o = outs.data.find((x) => x.attributes["name"] === name);
        if (!o)
          throw new TfApiError(
            404,
            `HCP Terraform plugin: output "${name}" is not in the current state`,
          );
        return mapOutput(accountId, wsId, s(ws.data.attributes["name"]), o);
      }
      case "variable-set": {
        const v = (await tfGet<A>(this.ctx, `/varsets/${enc(id)}`)).data;
        return stash(mapVarset(accountId, this.org, v), {
          [DETAIL_KEYS.workspaces]: await this.workspaceOptions(),
          [DETAIL_KEYS.projects]: await this.projectOptions(),
        });
      }
      case "varset-variable": {
        const [vsId, varId] = splitFirst(id);
        const [vs, vars] = await Promise.all([
          tfGet<A>(this.ctx, `/varsets/${enc(vsId)}`),
          tfList<A>(this.ctx, `/varsets/${enc(vsId)}/relationships/vars`),
        ]);
        const v = vars.data.find((x) => x.id === varId);
        if (!v) throw new TfApiError(404, `HCP Terraform plugin: variable ${varId} not found`);
        return mapVarsetVariable(accountId, vsId, s(vs.data.attributes["name"]), v);
      }
      case "agent-pool":
        return mapAgentPool(
          accountId,
          this.org,
          (await tfGet<A>(this.ctx, `/agent-pools/${enc(id)}`)).data,
        );
      case "agent": {
        const [poolId, agentId] = splitFirst(id);
        const [a, p] = await Promise.all([
          tfGet<A>(this.ctx, `/agents/${enc(agentId)}`),
          tfGet<A>(this.ctx, `/agent-pools/${enc(poolId)}`).catch(() => undefined),
        ]);
        return mapAgent(accountId, poolId, p ? s(p.data.attributes["name"]) : "", a.data);
      }
      case "agent-token": {
        const [poolId, tokenId] = splitFirst(id);
        const [t, p] = await Promise.all([
          tfGet<A>(this.ctx, `/authentication-tokens/${enc(tokenId)}`),
          tfGet<A>(this.ctx, `/agent-pools/${enc(poolId)}`).catch(() => undefined),
        ]);
        return mapAgentToken(accountId, poolId, p ? s(p.data.attributes["name"]) : "", t.data);
      }
      case "policy-set": {
        const p = (await tfGet<A>(this.ctx, `/policy-sets/${enc(id)}`)).data;
        return stash(mapPolicySet(accountId, this.org, p), {
          [DETAIL_KEYS.workspaces]: await this.workspaceOptions(),
          [DETAIL_KEYS.projects]: await this.projectOptions(),
        });
      }
      case "team":
        return mapTeam(accountId, this.org, (await tfGet<A>(this.ctx, `/teams/${enc(id)}`)).data);
      case "run-task":
        return mapRunTask(
          accountId,
          this.org,
          (await tfGet<A>(this.ctx, `/tasks/${enc(id)}`)).data,
        );
      case "registry-module":
        return mapRegistryModule(
          accountId,
          this.org,
          (
            await tfGet<A>(
              this.ctx,
              `${this.base}/registry-modules/${id.split("/").map(enc).join("/")}`,
            )
          ).data,
        );
      case "registry-provider":
        return mapRegistryProvider(
          accountId,
          this.org,
          (
            await tfGet<A>(
              this.ctx,
              `${this.base}/registry-providers/${id.split("/").map(enc).join("/")}`,
            )
          ).data,
        );
      default:
        throw new Error(`HCP Terraform plugin: unknown resource type "${typeId}"`);
    }
  }

  private async workspaceDetail(accountId: string, id: string): Promise<ResourceInstance> {
    const res = await tfGet<A>(this.ctx, `/workspaces/${enc(id)}`, {
      include: "current_run,project",
    });
    const w = res.data;
    const name = s(w.attributes["name"]);
    const [health, runs, versions, pools, projects] = await Promise.all([
      this.health(),
      tfList<A>(
        this.ctx,
        `/workspaces/${enc(id)}/runs`,
        { include: "plan", "page[size]": 15 },
        1,
      ).catch(() => undefined),
      tfList<A>(
        this.ctx,
        "/state-versions",
        {
          "filter[workspace][name]": name,
          "filter[organization][name]": this.org,
          "page[size]": 10,
        },
        1,
      ).catch(() => undefined),
      this.pools().catch(() => [] as Doc<A>[]),
      this.projectOptions(),
    ]);
    const assessmentId = relId(w, "current-assessment-result");
    const assessment = assessmentId
      ? await tfGet<A>(this.ctx, `/assessment-results/${enc(assessmentId)}`).catch(() => undefined)
      : undefined;
    const plans = new Map(
      (runs?.included ?? [])
        .filter((d) => d.type === "plans")
        .map((d) => [d.id, d.attributes as A]),
    );
    const runRows: RunRow[] = (runs?.data ?? []).map((r) => {
      const p = plans.get(relId(r, "plan") ?? "");
      return {
        id: r.id,
        status: s(r.attributes["status"]),
        message: s(r.attributes["message"]),
        createdAt: s(r.attributes["created-at"]),
        source: s(r.attributes["source"]),
        ...(p
          ? {
              add: Number(p["resource-additions"] ?? 0),
              change: Number(p["resource-changes"] ?? 0),
              destroy: Number(p["resource-destructions"] ?? 0),
            }
          : {}),
      };
    });
    const versionRows: StateVersionRow[] = (versions?.data ?? []).map((v) => {
      const a = v.attributes;
      return {
        id: v.id,
        createdAt: s(a["created-at"]),
        ...(typeof a["serial"] === "number" ? { serial: a["serial"] } : {}),
        ...(Array.isArray(a["resources"])
          ? { resources: (a["resources"] as unknown[]).length }
          : {}),
        ...(a["terraform-version"] ? { terraformVersion: s(a["terraform-version"]) } : {}),
        ...(a["vcs-commit-sha"] ? { vcsCommit: s(a["vcs-commit-sha"]) } : {}),
      };
    });
    const r = this.workspaceDoc(accountId, w, res.included ?? [], health);
    const aa = assessment?.data.attributes;
    return stash(r, {
      [DETAIL_KEYS.runs]: runRows,
      [DETAIL_KEYS.stateVersions]: versionRows,
      [DETAIL_KEYS.assessment]: aa
        ? {
            drifted: aa["drifted"],
            succeeded: aa["succeeded"],
            createdAt: aa["created-at"],
            ...(aa["error-msg"] ? { error: aa["error-msg"] } : {}),
          }
        : undefined,
      [DETAIL_KEYS.agentPools]: pools.map((p) => ({ id: p.id, name: s(p.attributes["name"]) })),
      [DETAIL_KEYS.projects]: projects,
    });
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "state-output" && outputKey === "value") {
      const [wsId, name] = splitFirst(externalIdOf(resourceId));
      const outs = await tfList<A>(
        this.ctx,
        `/workspaces/${enc(wsId)}/current-state-version-outputs`,
      );
      const o = outs.data.find((x) => x.attributes["name"] === name);
      if (!o)
        throw new Error(
          `HCP Terraform plugin: output "${name}" is not in the workspace's current state`,
        );
      if (o.attributes["sensitive"] !== true) return outputText(o.attributes["value"]);
      // The current-outputs list hides sensitive values; the single-output read returns them.
      const full = await tfGet<A>(this.ctx, `/state-version-outputs/${enc(o.id)}`);
      return outputText(full.data.attributes["value"]);
    }
    if (typeId === "agent-token" && outputKey === "token") {
      const value = await this.secrets?.getPlaintext(resourceId, "token");
      if (value) return value;
      throw new Error(
        "HCP Terraform only shows an agent token when it is created. This token was not created from Infrawrench; use Get credentials on its agent pool for a new one.",
      );
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    const v = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    if (v !== undefined) return String(v);
    throw new Error(
      `HCP Terraform plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, logs, cost, quotas
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");
    switch (resourceTypeId) {
      case "organization":
        return [
          { label: "Workspaces", value: n(f["workspaceCount"]) },
          { label: "RUM", value: n(f["rumCount"]) },
          {
            label: "Drifted",
            value: n(f["driftedWorkspaces"]),
            variant: Number(f["driftedWorkspaces"] ?? 0) > 0 ? "status-degraded" : "default",
          },
        ];
      case "workspace":
        return [
          { label: "Resources", value: n(f["resourceCount"]) },
          { label: "Run", value: String(f["currentRunStatus"] ?? "—") },
          {
            label: "Drift",
            value:
              f["drifted"] === true
                ? `${n(f["resourcesDrifted"])} resources`
                : f["drifted"] === false
                  ? "None"
                  : "—",
            variant: f["drifted"] === true ? "status-degraded" : "default",
          },
        ];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
    switch (resourceTypeId) {
      case "organization":
        return runMetrics(this.ctx, `${this.base}/runs`, range);
      case "workspace":
        return runMetrics(this.ctx, `/workspaces/${enc(externalIdOf(resourceId))}/runs`, range);
      default:
        return [];
    }
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "run") throw new Error(`HCP Terraform plugin: no logs for "${typeId}"`);
    const run = (await tfGet<A>(this.ctx, `/runs/${enc(externalIdOf(resourceId))}`)).data;
    const planId = relId(run, "plan");
    const applyId = relId(run, "apply");
    const status = s(run.attributes["status"]);
    const hasApply =
      Boolean(applyId) && ["applying", "applied", "errored", "apply_queued"].includes(status);
    const containers = hasApply ? ["plan", "apply"] : ["plan"];
    const active =
      params.container && containers.includes(params.container)
        ? params.container
        : containers[containers.length - 1]!;
    const phaseId = active === "apply" ? applyId : planId;
    let text = "";
    if (phaseId) {
      const phase = (
        await tfGet<A>(this.ctx, `/${active === "apply" ? "applies" : "plans"}/${enc(phaseId)}`)
      ).data;
      const url = s(phase.attributes["log-read-url"]);
      if (url) {
        try {
          text = await tfRaw(this.ctx, url, { anonymous: true });
        } catch (err) {
          if (statusOf(err) !== 404) throw err;
        }
      }
    }
    const lines = Math.min(MAX_LOG_LINES, Math.max(1, params.tailLines ?? 500));
    return { text: tailLines(cleanTerraformLog(text), lines), containers, activeContainer: active };
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchInvoiceCost(this.ctx, this.org, range);
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    let ent: A;
    try {
      ent = (await tfGet<A>(this.ctx, `${this.base}/entitlement-set`)).data.attributes;
    } catch (err) {
      if (statusOf(err) === 401 || statusOf(err) === 403 || statusOf(err) === 404) {
        throw new QuotaAccessError(
          "The token cannot read the organization's entitlements; use a user or owners team token.",
        );
      }
      throw err;
    }
    const out: QuotaUsage[] = [];
    const add = async (key: string, name: string, path: string, unit: string) => {
      const limit = ent[key];
      if (typeof limit !== "number") return;
      const used = await tfCount(this.ctx, path);
      if (used === undefined) return;
      out.push({ id: key, service: "HCP Terraform", name, limit, used, unit });
    };
    await add("user-limit", "Users", `${this.base}/organization-memberships`, "users");
    await add("policy-set-limit", "Policy sets", `${this.base}/policy-sets`, "policy sets");
    await add("policy-limit", "Policies", `${this.base}/policies`, "policies");
    await add("run-task-limit", "Run tasks", `${this.base}/tasks`, "run tasks");
    return out;
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async oauthTokenOptions(): Promise<Option[]> {
    try {
      const clients = await tfList<A>(this.ctx, `${this.base}/oauth-clients`);
      const out: Option[] = [];
      for (const c of clients.data) {
        const label =
          s(c.attributes["name"]) ||
          s(c.attributes["service-provider-display-name"]) ||
          s(c.attributes["service-provider"]);
        const tokens = c.relationships?.["oauth-tokens"]?.data;
        for (const t of Array.isArray(tokens) ? tokens : [])
          out.push({ id: t.id, name: `${label} (${t.id})` });
      }
      return out;
    } catch {
      return [];
    }
  }

  private parentField(
    key: string,
    label: string,
    options: Option[],
    parentResourceId: string | undefined,
  ): CreateFieldConfig[] {
    if (parentResourceId) return [];
    return [
      {
        key,
        label,
        kind: "select",
        required: true,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
        options: options.map((o) => ({ id: o.id, label: o.name })),
      },
    ];
  }

  private variableFields(): CreateFieldConfig[] {
    return [
      { key: "key", label: "Key", kind: "text", required: true, placeholder: "region" },
      { key: "value", label: "Value", kind: "text", required: false, multiline: true },
      {
        key: "category",
        label: "Category",
        kind: "select",
        required: true,
        defaultValue: "terraform",
        options: [
          { id: "terraform", label: "Terraform variable", description: "A var.<key> input." },
          {
            id: "env",
            label: "Environment variable",
            description: "Set in the run's environment, e.g. AWS_REGION.",
          },
        ],
      },
      {
        key: "hcl",
        label: "HCL",
        kind: "select",
        required: false,
        defaultValue: "false",
        options: [
          { id: "false", label: "Plain string" },
          { id: "true", label: "HCL (lists, maps, numbers)" },
        ],
      },
      {
        key: "sensitive",
        label: "Sensitive",
        kind: "select",
        required: false,
        defaultValue: "false",
        options: [
          { id: "false", label: "No" },
          { id: "true", label: "Yes: write-only from now on" },
        ],
      },
      { key: "description", label: "Description", kind: "text", required: false },
    ];
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "project":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "networking" },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "workspace": {
        const [projects, pools, oauth] = await Promise.all([
          this.projectOptions(),
          this.pools().catch(() => [] as Doc<A>[]),
          this.oauthTokenOptions(),
        ]);
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "networking-prod",
            },
            ...this.parentField("project", "Project", projects, parentResourceId),
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "terraformVersion",
              label: "Terraform version",
              kind: "text",
              required: false,
              placeholder: "~> 1.9",
              description: "Leave empty for the latest release.",
            },
            {
              key: "executionMode",
              label: "Execution mode",
              kind: "select",
              required: true,
              defaultValue: "remote",
              options: [
                { id: "remote", label: "Remote", description: "Runs on HCP Terraform." },
                ...(pools.length > 0
                  ? [
                      {
                        id: "agent",
                        label: "Agent",
                        description: "Runs on an agent pool you host.",
                      },
                    ]
                  : []),
                {
                  id: "local",
                  label: "Local",
                  description: "Runs elsewhere; HCP Terraform only stores state.",
                },
              ],
            },
            ...(pools.length > 0
              ? [
                  {
                    key: "agentPool",
                    label: "Agent pool",
                    kind: "select" as const,
                    required: true,
                    defaultValue: pools[0]!.id,
                    showWhen: { fieldKey: "executionMode", fieldValue: "agent" },
                    options: pools.map((p) => ({ id: p.id, label: s(p.attributes["name"]) })),
                  },
                ]
              : []),
            {
              key: "autoApply",
              label: "Apply automatically",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No, wait for confirmation" },
                { id: "true", label: "Yes, after a successful plan" },
              ],
            },
            {
              key: "workingDirectory",
              label: "Working directory",
              kind: "text",
              required: false,
              placeholder: "envs/prod",
            },
            ...(oauth.length > 0
              ? [
                  {
                    key: "oauthToken",
                    label: "VCS connection",
                    kind: "select" as const,
                    required: false,
                    defaultValue: "",
                    options: [
                      { id: "", label: "None: CLI or API driven" },
                      ...oauth.map((o) => ({ id: o.id, label: o.name })),
                    ],
                  },
                  {
                    key: "repository",
                    label: "Repository",
                    kind: "text" as const,
                    required: false,
                    placeholder: "acme/infrastructure",
                    description: "org/repo on the VCS connection.",
                    showWhen: { fieldKey: "oauthToken", fieldValuesNot: [""] },
                  },
                  {
                    key: "branch",
                    label: "Branch",
                    kind: "text" as const,
                    required: false,
                    placeholder: "main",
                    showWhen: { fieldKey: "oauthToken", fieldValuesNot: [""] },
                  },
                ]
              : []),
          ],
        };
      }
      case "run":
        return {
          fields: [
            ...this.parentField(
              "workspace",
              "Workspace",
              await this.workspaceOptions(),
              parentResourceId,
            ),
            RUN_KIND_FIELD,
            ...RUN_EXTRA_FIELDS,
          ],
        };
      case "variable":
        return {
          fields: [
            ...this.parentField(
              "workspace",
              "Workspace",
              await this.workspaceOptions(),
              parentResourceId,
            ),
            ...this.variableFields(),
          ],
        };
      case "varset-variable": {
        const sets = parentResourceId
          ? []
          : (await this.varsets().catch(() => [] as Doc<A>[])).map((v) => ({
              id: v.id,
              name: s(v.attributes["name"]),
            }));
        return {
          fields: [
            ...this.parentField("varset", "Variable set", sets, parentResourceId),
            ...this.variableFields(),
          ],
        };
      }
      case "variable-set":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "aws-credentials",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "global",
              label: "Scope",
              kind: "select",
              required: true,
              defaultValue: "false",
              options: [
                { id: "false", label: "Chosen workspaces and projects" },
                { id: "true", label: "Every workspace in the organization" },
              ],
            },
            {
              key: "priority",
              label: "Priority",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "Workspace variables win" },
                { id: "true", label: "This set wins and cannot be overridden" },
              ],
            },
          ],
        };
      case "agent-pool":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "on-prem" },
            {
              key: "organizationScoped",
              label: "Available to",
              kind: "select",
              required: true,
              defaultValue: "true",
              options: [
                { id: "true", label: "Every workspace" },
                { id: "false", label: "Only workspaces you allow later" },
              ],
            },
          ],
        };
      case "agent-token": {
        const pools = parentResourceId
          ? []
          : (await this.pools().catch(() => [] as Doc<A>[])).map((p) => ({
              id: p.id,
              name: s(p.attributes["name"]),
            }));
        return {
          fields: [
            ...this.parentField("pool", "Agent pool", pools, parentResourceId),
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: true,
              placeholder: "k8s agents",
            },
          ],
        };
      }
      case "policy-set": {
        const oauth = await this.oauthTokenOptions();
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "baseline" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "kind",
              label: "Framework",
              kind: "select",
              required: true,
              defaultValue: "sentinel",
              options: [
                { id: "sentinel", label: "Sentinel" },
                { id: "opa", label: "Open Policy Agent" },
              ],
            },
            {
              key: "global",
              label: "Scope",
              kind: "select",
              required: true,
              defaultValue: "false",
              options: [
                { id: "false", label: "Chosen workspaces and projects" },
                { id: "true", label: "Every workspace" },
              ],
            },
            ...(oauth.length > 0
              ? [
                  {
                    key: "oauthToken",
                    label: "Policies from VCS",
                    kind: "select" as const,
                    required: false,
                    defaultValue: "",
                    options: [
                      { id: "", label: "None: upload versions later" },
                      ...oauth.map((o) => ({ id: o.id, label: o.name })),
                    ],
                  },
                  {
                    key: "repository",
                    label: "Repository",
                    kind: "text" as const,
                    required: false,
                    placeholder: "acme/policies",
                    showWhen: { fieldKey: "oauthToken", fieldValuesNot: [""] },
                  },
                  {
                    key: "branch",
                    label: "Branch",
                    kind: "text" as const,
                    required: false,
                    showWhen: { fieldKey: "oauthToken", fieldValuesNot: [""] },
                  },
                  {
                    key: "policiesPath",
                    label: "Policies path",
                    kind: "text" as const,
                    required: false,
                    placeholder: "sentinel/",
                    showWhen: { fieldKey: "oauthToken", fieldValuesNot: [""] },
                  },
                ]
              : []),
          ],
        };
      }
      case "team":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "platform" },
            {
              key: "visibility",
              label: "Visibility",
              kind: "select",
              required: true,
              defaultValue: "organization",
              options: [
                { id: "organization", label: "Visible to the organization" },
                { id: "secret", label: "Secret: members and owners only" },
              ],
            },
          ],
        };
      case "run-task":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "security-scan",
            },
            {
              key: "url",
              label: "Endpoint URL",
              kind: "text",
              required: true,
              placeholder: "https://scanner.example.com/hook",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            { key: "hmacKey", label: "HMAC key", kind: "password", required: false },
          ],
        };
      default:
        throw new Error(`HCP Terraform plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private varAttributes(fields: Record<string, string>, create: boolean): Record<string, unknown> {
    const attrs: Record<string, unknown> = {};
    if ("key" in fields) attrs["key"] = (fields["key"] ?? "").trim();
    if ("value" in fields && (create || fields["value"] !== ""))
      attrs["value"] = fields["value"] ?? "";
    if ("category" in fields && fields["category"]) attrs["category"] = fields["category"];
    if ("hcl" in fields) attrs["hcl"] = bool(fields["hcl"]);
    if ("sensitive" in fields) attrs["sensitive"] = bool(fields["sensitive"]);
    if ("description" in fields) attrs["description"] = fields["description"] ?? "";
    if (create && !attrs["key"]) throw new Error('HCP Terraform plugin: "Key" is required');
    if (create && !attrs["category"]) attrs["category"] = "terraform";
    return attrs;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : undefined;
    const need = (key: string, label: string) => {
      const v = (fields[key] ?? "").trim();
      if (!v) throw new Error(`HCP Terraform plugin: "${label}" is required`);
      return v;
    };
    const opt = (key: string) => (fields[key] ?? "").trim();
    switch (typeId) {
      case "project": {
        const p = await tfWrite<A>(
          this.ctx,
          "POST",
          `${this.base}/projects`,
          doc("projects", {
            name: need("name", "Name"),
            ...(opt("description") ? { description: opt("description") } : {}),
          }),
        );
        this.projectsCache = undefined;
        return mapProject(accountId, this.org, p!, this.url(`projects/${p!.id}`), 0);
      }
      case "workspace": {
        const project = opt("project") || parent;
        const mode = opt("executionMode") || "remote";
        const oauth = opt("oauthToken");
        const w = await tfWrite<A>(
          this.ctx,
          "POST",
          `${this.base}/workspaces`,
          doc(
            "workspaces",
            {
              name: need("name", "Name"),
              ...(opt("description") ? { description: opt("description") } : {}),
              ...(opt("terraformVersion") ? { "terraform-version": opt("terraformVersion") } : {}),
              "execution-mode": mode,
              ...(mode === "agent" ? { "agent-pool-id": need("agentPool", "Agent pool") } : {}),
              "auto-apply": bool(fields["autoApply"]),
              ...(opt("workingDirectory") ? { "working-directory": opt("workingDirectory") } : {}),
              ...(oauth
                ? {
                    "vcs-repo": {
                      "oauth-token-id": oauth,
                      identifier: need("repository", "Repository"),
                      ...(opt("branch") ? { branch: opt("branch") } : {}),
                    },
                  }
                : {}),
              "source-name": "Infrawrench",
            },
            project ? { project: { data: { type: "projects", id: project } } } : undefined,
          ),
        );
        this.workspacesCache = undefined;
        return this.workspaceDoc(accountId, w!, []);
      }
      case "run": {
        const ws = opt("workspace") || parent || need("workspace", "Workspace");
        const r = await tfWrite<A>(
          this.ctx,
          "POST",
          "/runs",
          doc("runs", runAttributes(fields), {
            workspace: { data: { type: "workspaces", id: ws } },
          }),
        );
        return this.getResource("run", `${accountId}:run:${r!.id}`, accountId);
      }
      case "variable": {
        const ws = opt("workspace") || parent || need("workspace", "Workspace");
        const v = await tfWrite<A>(
          this.ctx,
          "POST",
          `/workspaces/${enc(ws)}/vars`,
          doc("vars", this.varAttributes(fields, true)),
        );
        const w = await tfGet<A>(this.ctx, `/workspaces/${enc(ws)}`).catch(() => undefined);
        return mapVariable(accountId, ws, w ? s(w.data.attributes["name"]) : "", v!);
      }
      case "varset-variable": {
        const vs = opt("varset") || parent || need("varset", "Variable set");
        const v = await tfWrite<A>(
          this.ctx,
          "POST",
          `/varsets/${enc(vs)}/relationships/vars`,
          doc("vars", this.varAttributes(fields, true)),
        );
        return mapVarsetVariable(accountId, vs, "", v!);
      }
      case "variable-set": {
        const v = await tfWrite<A>(
          this.ctx,
          "POST",
          `${this.base}/varsets`,
          doc("varsets", {
            name: need("name", "Name"),
            ...(opt("description") ? { description: opt("description") } : {}),
            global: bool(fields["global"]),
            priority: bool(fields["priority"]),
          }),
        );
        this.varsetsCache = undefined;
        return mapVarset(accountId, this.org, v!);
      }
      case "agent-pool": {
        const p = await tfWrite<A>(
          this.ctx,
          "POST",
          `${this.base}/agent-pools`,
          doc("agent-pools", {
            name: need("name", "Name"),
            "organization-scoped": fields["organizationScoped"] !== "false",
          }),
        );
        this.poolsCache = undefined;
        return mapAgentPool(accountId, this.org, p!);
      }
      case "agent-token": {
        const pool = opt("pool") || parent || need("pool", "Agent pool");
        const t = await tfWrite<A>(
          this.ctx,
          "POST",
          `/agent-pools/${enc(pool)}/authentication-tokens`,
          doc("authentication-tokens", { description: need("description", "Description") }),
        );
        const resource = mapAgentToken(accountId, pool, "", t!);
        const token = s(t!.attributes["token"]);
        const warnings = [];
        if (token && this.secrets?.setPlaintext) {
          await this.secrets.setPlaintext(resource.id, "token", token);
        } else {
          warnings.push({
            code: "token-not-kept",
            message:
              "The token was created, but its value could not be kept: HCP Terraform shows it only once. Revoke it and use Get credentials on the agent pool to see a new token's value.",
          });
        }
        return { resource, warnings };
      }
      case "policy-set": {
        const oauth = opt("oauthToken");
        const p = await tfWrite<A>(
          this.ctx,
          "POST",
          `${this.base}/policy-sets`,
          doc("policy-sets", {
            name: need("name", "Name"),
            ...(opt("description") ? { description: opt("description") } : {}),
            kind: opt("kind") || "sentinel",
            global: bool(fields["global"]),
            ...(oauth
              ? {
                  "vcs-repo": {
                    "oauth-token-id": oauth,
                    identifier: need("repository", "Repository"),
                    ...(opt("branch") ? { branch: opt("branch") } : {}),
                  },
                  ...(opt("policiesPath") ? { "policies-path": opt("policiesPath") } : {}),
                }
              : {}),
          }),
        );
        return mapPolicySet(accountId, this.org, p!);
      }
      case "team": {
        const t = await tfWrite<A>(
          this.ctx,
          "POST",
          `${this.base}/teams`,
          doc("teams", {
            name: need("name", "Name"),
            visibility: opt("visibility") || "organization",
          }),
        );
        return mapTeam(accountId, this.org, t!);
      }
      case "run-task": {
        const t = await tfWrite<A>(
          this.ctx,
          "POST",
          `${this.base}/tasks`,
          doc("tasks", {
            name: need("name", "Name"),
            url: need("url", "Endpoint URL"),
            category: "task",
            ...(opt("description") ? { description: opt("description") } : {}),
            ...(fields["hmacKey"] ? { "hmac-key": fields["hmacKey"] } : {}),
            enabled: true,
          }),
        );
        return mapRunTask(accountId, this.org, t!);
      }
      default:
        throw new Error(`HCP Terraform plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const has = (k: string) => k in fields;
    const text = (k: string) => (fields[k] ?? "").trim();
    const pick = (
      map: Record<string, string>,
      kinds: Record<string, "bool" | "text" | "nullable">,
    ) => {
      const attrs: Record<string, unknown> = {};
      for (const [field, attr] of Object.entries(map)) {
        if (!has(field)) continue;
        const kind = kinds[field] ?? "text";
        attrs[attr] =
          kind === "bool"
            ? bool(fields[field])
            : kind === "nullable"
              ? text(field) || null
              : text(field);
      }
      return attrs;
    };
    switch (typeId) {
      case "organization": {
        const attrs = pick(
          {
            email: "email",
            defaultExecutionMode: "default-execution-mode",
            costEstimationEnabled: "cost-estimation-enabled",
            assessmentsEnforced: "assessments-enforced",
            allowForceDeleteWorkspaces: "allow-force-delete-workspaces",
          },
          {
            costEstimationEnabled: "bool",
            assessmentsEnforced: "bool",
            allowForceDeleteWorkspaces: "bool",
          },
        );
        if (Object.keys(attrs).length > 0) {
          await tfWrite(this.ctx, "PATCH", this.base, doc("organizations", attrs));
          this.orgCache = undefined;
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "project": {
        const attrs = pick(
          {
            name: "name",
            description: "description",
            defaultExecutionMode: "default-execution-mode",
            autoDestroyActivityDuration: "auto-destroy-activity-duration",
          },
          { autoDestroyActivityDuration: "nullable" },
        );
        if (Object.keys(attrs).length > 0)
          await tfWrite(this.ctx, "PATCH", `/projects/${enc(id)}`, doc("projects", attrs));
        return this.getResource(typeId, resourceId, accountId);
      }
      case "workspace": {
        const attrs = pick(
          {
            name: "name",
            description: "description",
            terraformVersion: "terraform-version",
            executionMode: "execution-mode",
            workingDirectory: "working-directory",
            autoApply: "auto-apply",
            autoApplyRunTrigger: "auto-apply-run-trigger",
            assessmentsEnabled: "assessments-enabled",
            allowDestroyPlan: "allow-destroy-plan",
            speculativeEnabled: "speculative-enabled",
            fileTriggersEnabled: "file-triggers-enabled",
            queueAllRuns: "queue-all-runs",
            globalRemoteState: "global-remote-state",
            autoDestroyAt: "auto-destroy-at",
            autoDestroyActivityDuration: "auto-destroy-activity-duration",
          },
          {
            autoApply: "bool",
            autoApplyRunTrigger: "bool",
            assessmentsEnabled: "bool",
            allowDestroyPlan: "bool",
            speculativeEnabled: "bool",
            fileTriggersEnabled: "bool",
            queueAllRuns: "bool",
            globalRemoteState: "bool",
            autoDestroyAt: "nullable",
            autoDestroyActivityDuration: "nullable",
          },
        );
        if (attrs["execution-mode"] === "agent") {
          throw new Error(
            "HCP Terraform plugin: switch to agent execution with the Execution action, which also picks the agent pool",
          );
        }
        if (Object.keys(attrs).length > 0) {
          await tfWrite(this.ctx, "PATCH", `/workspaces/${enc(id)}`, doc("workspaces", attrs));
          this.workspacesCache = undefined;
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "variable": {
        const [ws, varId] = splitFirst(id);
        const attrs = this.varAttributes(fields, false);
        if (Object.keys(attrs).length > 0) {
          await tfWrite(
            this.ctx,
            "PATCH",
            `/workspaces/${enc(ws)}/vars/${enc(varId)}`,
            doc("vars", attrs, undefined, varId),
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "varset-variable": {
        const [vs, varId] = splitFirst(id);
        const attrs = this.varAttributes(fields, false);
        if (Object.keys(attrs).length > 0) {
          await tfWrite(
            this.ctx,
            "PATCH",
            `/varsets/${enc(vs)}/relationships/vars/${enc(varId)}`,
            doc("vars", attrs),
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "variable-set": {
        const attrs = pick(
          { name: "name", description: "description", global: "global", priority: "priority" },
          { global: "bool", priority: "bool" },
        );
        if (Object.keys(attrs).length > 0)
          await tfWrite(this.ctx, "PATCH", `/varsets/${enc(id)}`, doc("varsets", attrs));
        return this.getResource(typeId, resourceId, accountId);
      }
      case "agent-pool": {
        const attrs = pick(
          { name: "name", organizationScoped: "organization-scoped" },
          { organizationScoped: "bool" },
        );
        if (Object.keys(attrs).length > 0)
          await tfWrite(this.ctx, "PATCH", `/agent-pools/${enc(id)}`, doc("agent-pools", attrs));
        return this.getResource(typeId, resourceId, accountId);
      }
      case "policy-set": {
        const attrs = pick(
          {
            name: "name",
            description: "description",
            global: "global",
            overridable: "overridable",
            agentEnabled: "agent-enabled",
            policyToolVersion: "policy-tool-version",
            policiesPath: "policies-path",
          },
          { global: "bool", overridable: "bool", agentEnabled: "bool" },
        );
        if (Object.keys(attrs).length > 0)
          await tfWrite(this.ctx, "PATCH", `/policy-sets/${enc(id)}`, doc("policy-sets", attrs));
        return this.getResource(typeId, resourceId, accountId);
      }
      case "team": {
        const attrs = pick(
          {
            name: "name",
            visibility: "visibility",
            ssoTeamId: "sso-team-id",
            allowMemberTokenManagement: "allow-member-token-management",
          },
          { allowMemberTokenManagement: "bool" },
        );
        const access: Record<string, boolean> = {};
        for (const k of TEAM_ACCESS_FLAGS) if (has(camel(k))) access[k] = bool(fields[camel(k)]);
        if (Object.keys(access).length > 0) attrs["organization-access"] = access;
        if (Object.keys(attrs).length > 0)
          await tfWrite(this.ctx, "PATCH", `/teams/${enc(id)}`, doc("teams", attrs));
        return this.getResource(typeId, resourceId, accountId);
      }
      case "run-task": {
        const attrs = pick(
          { name: "name", url: "url", description: "description", enabled: "enabled" },
          { enabled: "bool" },
        );
        if (fields["hmacKey"]) attrs["hmac-key"] = fields["hmacKey"];
        if (Object.keys(attrs).length > 0) {
          await tfWrite(
            this.ctx,
            "PATCH",
            `/tasks/${enc(id)}`,
            doc("tasks", { ...attrs, category: "task" }),
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`HCP Terraform plugin: cannot edit "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const del = (path: string) => tfWrite(this.ctx, "DELETE", path);
    switch (typeId) {
      case "project":
        await del(`/projects/${enc(id)}`);
        this.projectsCache = undefined;
        return;
      case "workspace":
        // Safe delete refuses while the workspace still manages resources, so
        // an Infrawrench delete never orphans live infrastructure.
        await tfWrite(this.ctx, "POST", `/workspaces/${enc(id)}/actions/safe-delete`);
        this.workspacesCache = undefined;
        return;
      case "variable": {
        const [ws, v] = splitFirst(id);
        await del(`/workspaces/${enc(ws)}/vars/${enc(v)}`);
        return;
      }
      case "varset-variable": {
        const [vs, v] = splitFirst(id);
        await del(`/varsets/${enc(vs)}/relationships/vars/${enc(v)}`);
        return;
      }
      case "variable-set":
        await del(`/varsets/${enc(id)}`);
        this.varsetsCache = undefined;
        return;
      case "agent-pool":
        await del(`/agent-pools/${enc(id)}`);
        this.poolsCache = undefined;
        return;
      case "agent":
        await del(`/agents/${enc(splitFirst(id)[1])}`);
        return;
      case "agent-token":
        await del(`/authentication-tokens/${enc(splitFirst(id)[1])}`);
        return;
      case "policy-set":
        await del(`/policy-sets/${enc(id)}`);
        return;
      case "team":
        await del(`/teams/${enc(id)}`);
        return;
      case "run-task":
        await del(`/tasks/${enc(id)}`);
        return;
      case "registry-module":
        await del(`${this.base}/registry-modules/${id.split("/").map(enc).join("/")}`);
        return;
      case "registry-provider":
        await del(`${this.base}/registry-providers/${id.split("/").map(enc).join("/")}`);
        return;
      default:
        throw new Error(`HCP Terraform plugin: cannot delete "${typeId}" from Infrawrench`);
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
    if (typeId === "workspace" && (actionId === "unlock" || actionId === "force-unlock")) {
      await tfWrite(this.ctx, "POST", `/workspaces/${enc(id)}/actions/${actionId}`);
      return;
    }
    if (typeId === "run" && actionId === "force-cancel") {
      await tfWrite(this.ctx, "POST", `/runs/${enc(id)}/actions/force-cancel`, {});
      return;
    }
    throw new Error(`HCP Terraform plugin: unknown action "${actionId}" for "${typeId}"`);
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
    const comment = (vals["comment"] ?? "").trim();
    switch (command) {
      case "queueRun":
        if (typeId !== "workspace") break;
        await tfWrite(
          this.ctx,
          "POST",
          "/runs",
          doc("runs", runAttributes(vals), {
            workspace: { data: { type: "workspaces", id } },
          }),
        );
        return null;
      case "lock":
        if (typeId !== "workspace") break;
        await tfWrite(this.ctx, "POST", `/workspaces/${enc(id)}/actions/lock`, {
          reason: (vals["reason"] ?? "").trim() || "Locked from Infrawrench",
        });
        return null;
      case "moveProject":
        if (typeId !== "workspace") break;
        if (!vals["projectId"]) throw new Error("HCP Terraform plugin: choose a project");
        await tfWrite(
          this.ctx,
          "PATCH",
          `/workspaces/${enc(id)}`,
          doc(
            "workspaces",
            {},
            {
              project: { data: { type: "projects", id: vals["projectId"] } },
            },
          ),
        );
        return null;
      case "setExecution": {
        if (typeId !== "workspace") break;
        const mode = vals["mode"] || "remote";
        if (mode === "agent" && !vals["agentPoolId"])
          throw new Error("HCP Terraform plugin: choose an agent pool");
        await tfWrite(
          this.ctx,
          "PATCH",
          `/workspaces/${enc(id)}`,
          doc("workspaces", {
            "execution-mode": mode,
            ...(mode === "agent" ? { "agent-pool-id": vals["agentPoolId"] } : {}),
          }),
        );
        return null;
      }
      case "applyRun":
      case "discardRun":
      case "cancelRun": {
        if (typeId !== "run") break;
        const verb =
          command === "applyRun" ? "apply" : command === "discardRun" ? "discard" : "cancel";
        await tfWrite(
          this.ctx,
          "POST",
          `/runs/${enc(id)}/actions/${verb}`,
          comment ? { comment } : {},
        );
        return null;
      }
      case "attach":
      case "attachProject": {
        if (typeId !== "variable-set" && typeId !== "policy-set") break;
        const kind = command === "attach" ? "workspaces" : "projects";
        const target = command === "attach" ? vals["workspaceId"] : vals["projectId"];
        if (!target) throw new Error("HCP Terraform plugin: choose what to apply it to");
        const base = typeId === "variable-set" ? `/varsets/${enc(id)}` : `/policy-sets/${enc(id)}`;
        await tfWrite(
          this.ctx,
          vals["op"] === "remove" ? "DELETE" : "POST",
          `${base}/relationships/${kind}`,
          {
            data: [{ type: kind, id: target }],
          },
        );
        return null;
      }
    }
    throw new Error(`HCP Terraform plugin: unknown command "${command}" for "${typeId}"`);
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    const id = externalIdOf(resourceId);
    if (typeId === "workspace" && (formatId === "state" || formatId === "state-json")) {
      const sv = (await tfGet<A>(this.ctx, `/workspaces/${enc(id)}/current-state-version`)).data;
      const url = s(
        sv.attributes[
          formatId === "state" ? "hosted-state-download-url" : "hosted-json-state-download-url"
        ],
      );
      if (!url)
        throw new Error("HCP Terraform did not return a download URL for this state version");
      const content = await tfRaw(this.ctx, url, { anonymous: true });
      const name = (await tfGet<A>(this.ctx, `/workspaces/${enc(id)}`).catch(() => undefined))?.data
        .attributes["name"];
      return {
        content,
        filename: `${s(name) || id}${formatId === "state" ? ".tfstate" : ".state.json"}`,
        mimeType: "application/json",
        warning:
          "State files can contain secrets (passwords, keys, tokens) in plain text. Store this file as carefully as the credentials it may hold.",
      };
    }
    if (typeId === "agent-pool" && formatId === "agent-token") {
      const t = await tfWrite<A>(
        this.ctx,
        "POST",
        `/agent-pools/${enc(id)}/authentication-tokens`,
        doc("authentication-tokens", {
          description: `Infrawrench ${new Date().toISOString().slice(0, 10)}`,
        }),
      );
      const token = s(t?.attributes["token"]);
      if (!token) throw new Error("HCP Terraform did not return the new agent token");
      return {
        content: token,
        filename: "tfc-agent-token.txt",
        mimeType: "text/plain",
        fields: [{ label: "Token", value: token, sensitive: true, hint: "Only shown once" }],
        warning:
          "Save this token now: it is not shown again. Run the agent with TFC_AGENT_TOKEN set to it.",
      };
    }
    throw new Error(`HCP Terraform plugin: cannot export "${formatId}" for "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderTfDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderTfSidebar(resource);
  }
}
