import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceCreateReturn,
  ResourceInstance,
  SecretHostServices,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { PuContext } from "./api.js";
import {
  PulumiApiError,
  consoleUrl,
  enc,
  isSecretValue,
  normaliseApiUrl,
  puFetch,
  puPaged,
  puRaw,
  stackPath,
  statusOf,
} from "./api.js";
import type {
  PuDeployment,
  PuEnvironment,
  PuPolicyGroup,
  PuPolicyPack,
  PuStack,
  PuStackSummary,
  PuTeam,
  PuToken,
  PuUpdate,
  PuWebhook,
} from "./mappers.js";
import {
  mapDeployment,
  mapEnvironment,
  mapOrganization,
  mapOutput,
  mapPolicyGroup,
  mapPolicyPack,
  mapProject,
  mapStack,
  mapTeam,
  mapToken,
  mapWebhook,
  outputText,
  parts,
  unixIso,
} from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, rangeOrDefault, updateSeries } from "./metrics.js";
import type { RevisionRow, ScheduleRow, UpdateRow } from "./render.js";
import { DETAIL_KEYS, OPERATIONS, renderPulumiDetail, renderPulumiSidebar } from "./render.js";
import type { PlanRates } from "./usage.js";
import { fetchSummary, fetchUsageCost, ratesFor, usageSeries } from "./usage.js";

const DEPLOYMENT_LIMIT = 50;
const MAX_LOG_PAGES = 40;
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

export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + (lines.length > 0 ? "\n" : "");
}

/**
 * An opened ESC environment's properties are `{value, secret, trace}`
 * wrappers all the way down; this strips them to plain JSON.
 */
export function unwrapEscValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unwrapEscValue);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (
    "value" in o &&
    ("trace" in o || "secret" in o || "unknown" in o || Object.keys(o).length === 1)
  ) {
    return unwrapEscValue(o["value"]);
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = unwrapEscValue(x);
  return out;
}

/** The decoded value of an encrypted output, given the API's base64 plaintext. */
export function decodePlaintext(b64: string): unknown {
  let text: string;
  try {
    text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    text = b64;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class PulumiCloudClient implements PluginClient {
  private readonly ctx: PuContext;
  private readonly org: string;
  private readonly rates: PlanRates;
  private readonly secrets: SecretHostServices | undefined;
  private stacksCache: Promise<PuStackSummary[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["accessToken"] ?? "").trim();
    if (!token) throw new Error("Pulumi Cloud plugin: missing accessToken credential");
    this.org = (credentials["organization"] ?? "").trim();
    if (!this.org) throw new Error("Pulumi Cloud plugin: pick an organization");
    const caCert = (credentials["caCert"] ?? "").trim();
    this.ctx = {
      token,
      apiUrl: normaliseApiUrl(credentials["apiUrl"]),
      ...(services?.http ? { http: services.http } : {}),
      ...(caCert ? { caCert } : {}),
    };
    this.rates = ratesFor(credentials["plan"], credentials["rateOverrides"]);
    this.secrets = services?.secrets;
  }

  private url(path: string): string {
    return `${consoleUrl(this.ctx.apiUrl)}/${enc(this.org)}${path}`;
  }

  private stacks(): Promise<PuStackSummary[]> {
    this.stacksCache ??= puPaged<PuStackSummary>(this.ctx, "/api/user/stacks", "stacks", {
      organization: this.org,
      maxResults: 500,
    }).catch((err: unknown) => {
      this.stacksCache = undefined;
      throw err;
    });
    return this.stacksCache;
  }

  private sp(project: string, stack: string): string {
    return stackPath(this.org, project, stack);
  }

  private stackUrl(project: string, stack: string): string {
    return this.url(`/${enc(project)}/${enc(stack)}`);
  }

  private async envList(): Promise<PuEnvironment[]> {
    return puPaged<PuEnvironment>(
      this.ctx,
      `/api/esc/environments/${enc(this.org)}`,
      "environments",
      {},
      20,
      "continuationToken",
      "nextToken",
    );
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization":
        return [await this.organizationResource(accountId, false)];
      case "project": {
        this.stacksCache = undefined;
        const byProject = new Map<string, PuStackSummary[]>();
        for (const s of await this.stacks())
          byProject.set(s.projectName, [...(byProject.get(s.projectName) ?? []), s]);
        return [...byProject.entries()].map(([p, st]) =>
          mapProject(accountId, this.org, p, st, this.url(`/${enc(p)}`)),
        );
      }
      case "stack":
        this.stacksCache = undefined;
        return (await this.stacks()).map((s) =>
          mapStack(accountId, s, this.stackUrl(s.projectName, s.stackName)),
        );
      case "stack-output": {
        const out: ResourceInstance[] = [];
        for (const s of await this.stacks()) {
          if (!s.resourceCount) continue;
          const res = await puFetch<{ outputs?: Record<string, unknown> }>(
            this.ctx,
            `${this.sp(s.projectName, s.stackName)}/outputs`,
          ).catch(() => undefined);
          for (const [name, value] of Object.entries(res?.outputs ?? {})) {
            out.push(
              mapOutput(
                accountId,
                s.projectName,
                s.stackName,
                name,
                isSecretValue(value) ? null : value,
                isSecretValue(value),
              ),
            );
          }
        }
        return out;
      }
      case "deployment": {
        try {
          const res = await puFetch<{ deployments?: PuDeployment[] }>(
            this.ctx,
            `/api/orgs/${enc(this.org)}/deployments`,
            {
              query: { pageSize: DEPLOYMENT_LIMIT, page: 1 },
            },
          );
          return (res?.deployments ?? []).map((d) =>
            mapDeployment(accountId, d, this.deploymentUrl(d)),
          );
        } catch (err) {
          if (statusOf(err) === 404 || statusOf(err) === 403) return [];
          throw err;
        }
      }
      case "environment":
        return (await this.envList())
          .filter((e) => !e.deletedAt)
          .map((e) =>
            mapEnvironment(accountId, this.org, e, this.envUrl(e.project || "default", e.name)),
          );
      case "access-token":
        return this.optional(async () =>
          (await puPaged<PuToken>(this.ctx, `/api/orgs/${enc(this.org)}/tokens`, "tokens")).map(
            (t) => mapToken(accountId, this.org, t),
          ),
        );
      case "team":
        return this.optional(async () =>
          (
            (await puFetch<{ teams?: PuTeam[] }>(this.ctx, `/api/orgs/${enc(this.org)}/teams`))
              ?.teams ?? []
          ).map((t) => mapTeam(accountId, this.org, t)),
        );
      case "webhook":
        return this.optional(async () =>
          ((await puFetch<PuWebhook[]>(this.ctx, `/api/orgs/${enc(this.org)}/hooks`)) ?? []).map(
            (w) => mapWebhook(accountId, this.org, w),
          ),
        );
      case "policy-pack":
        return this.optional(async () =>
          (
            (
              await puFetch<{ policyPacks?: PuPolicyPack[] }>(
                this.ctx,
                `/api/orgs/${enc(this.org)}/policypacks`,
              )
            )?.policyPacks ?? []
          ).map((p) => mapPolicyPack(accountId, this.org, p)),
        );
      case "policy-group":
        return this.optional(async () =>
          (
            (
              await puFetch<{ policyGroups?: PuPolicyGroup[] }>(
                this.ctx,
                `/api/orgs/${enc(this.org)}/policygroups`,
              )
            )?.policyGroups ?? []
          ).map((g) => mapPolicyGroup(accountId, this.org, g)),
        );
      default:
        throw new Error(`Pulumi Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  /** Plan- or role-gated lists answer 403/404: list nothing rather than fail the sync. */
  private async optional(fn: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await fn();
    } catch (err) {
      if (statusOf(err) === 403 || statusOf(err) === 404 || statusOf(err) === 402) return [];
      throw err;
    }
  }

  private deploymentUrl(d: PuDeployment): string {
    return `${this.stackUrl(d.projectName ?? "", d.stackName ?? "")}/deployments/${d.version ?? ""}`;
  }

  private envUrl(project: string, name: string): string {
    return `${consoleUrl(this.ctx.apiUrl)}/${enc(this.org)}/esc/${enc(project)}/${enc(name)}`;
  }

  private async organizationResource(
    accountId: string,
    detail: boolean,
  ): Promise<ResourceInstance> {
    const since = Date.now() - 30 * 86_400_000;
    const [user, stacks, members, envs, resources, deployments, secrets] = await Promise.all([
      puFetch<{ organizations?: Array<{ githubLogin?: string; role?: string }> }>(
        this.ctx,
        "/api/user",
      ).catch(() => undefined),
      this.stacks().catch(() => undefined),
      puPaged<unknown>(this.ctx, `/api/orgs/${enc(this.org)}/members`, "members").catch(
        () => undefined,
      ),
      this.envList().catch(() => undefined),
      fetchSummary(this.ctx, this.org, "resources", since).catch(() => undefined),
      fetchSummary(this.ctx, this.org, "deployments", since).catch(() => undefined),
      fetchSummary(this.ctx, this.org, "secrets", since).catch(() => undefined),
    ]);
    const sum = (d: Array<{ value: number }> | undefined) =>
      d ? d.reduce((s, x) => s + x.value, 0) : undefined;
    const latestRum = resources
      ?.filter((d) => typeof d.resources === "number")
      .slice(-1)[0]?.resources;
    const r = mapOrganization(
      accountId,
      this.org,
      `${consoleUrl(this.ctx.apiUrl)}/${enc(this.org)}`,
      {
        role: user?.organizations?.find((o) => o.githubLogin === this.org)?.role,
        memberCount: members?.length,
        stackCount: stacks?.length,
        projectCount: stacks ? new Set(stacks.map((s) => s.projectName)).size : undefined,
        environmentCount: envs?.filter((e) => !e.deletedAt).length,
        rum:
          latestRum !== undefined
            ? Math.round(latestRum)
            : stacks?.reduce((s, x) => s + (x.resourceCount ?? 0), 0),
        resourceHours30d: sum(resources),
        deploymentMinutes30d: sum(deployments),
        secretHours30d: sum(secrets),
      },
    );
    if (!detail) return r;
    const search = await puFetch<{
      aggregations?: Record<string, { results?: Array<{ name?: string; count?: number }> }>;
    }>(this.ctx, `/api/orgs/${enc(this.org)}/search/resourcesv2`, {
      query: { size: 1, top: 15 },
    }).catch(() => undefined);
    const aggs: Record<string, Array<{ name: string; count: number }>> = {};
    for (const key of ["type", "package", "project", "stack"]) {
      const buckets = search?.aggregations?.[key]?.results;
      if (buckets?.length)
        aggs[key] = buckets.map((b) => ({ name: b.name ?? "", count: b.count ?? 0 }));
    }
    return stash(r, { [DETAIL_KEYS.aggregations]: aggs });
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
    const [a, b, c] = parts(id);
    switch (typeId) {
      case "organization":
        return this.organizationResource(accountId, true);
      case "project": {
        const st = (await this.stacks()).filter((s) => s.projectName === id);
        return mapProject(accountId, this.org, id, st, this.url(`/${enc(id)}`));
      }
      case "stack":
        return this.stackDetail(accountId, a!, b!);
      case "stack-output": {
        const res = await puFetch<{ outputs?: Record<string, unknown> }>(
          this.ctx,
          `${this.sp(a!, b!)}/outputs`,
        );
        const value = res?.outputs?.[c ?? ""];
        if (value === undefined)
          throw new PulumiApiError(
            404,
            `Pulumi Cloud plugin: output "${c}" is not in the stack's latest update`,
          );
        return mapOutput(
          accountId,
          a!,
          b!,
          c!,
          isSecretValue(value) ? null : value,
          isSecretValue(value),
        );
      }
      case "deployment": {
        const d = await puFetch<PuDeployment>(
          this.ctx,
          `${this.sp(a!, b!)}/deployments/${enc(c!)}`,
        );
        return mapDeployment(
          accountId,
          { ...d, projectName: a!, stackName: b! },
          this.deploymentUrl({ ...d, projectName: a!, stackName: b! }),
        );
      }
      case "environment": {
        const envs = await this.envList();
        const e = envs.find((x) => (x.project || "default") === a && x.name === b);
        if (!e) throw new PulumiApiError(404, `Pulumi Cloud plugin: environment ${id} not found`);
        const revs = await puFetch<
          Array<{
            number: number;
            created: string;
            creatorName?: string;
            creatorLogin?: string;
            tags?: string[];
            retracted?: unknown;
          }>
        >(this.ctx, `/api/esc/environments/${enc(this.org)}/${enc(a!)}/${enc(b!)}/versions`, {
          query: { count: 20 },
        }).catch(() => undefined);
        const rows: RevisionRow[] = (revs ?? []).map((v) => ({
          number: v.number,
          created: v.created,
          ...(v.creatorName || v.creatorLogin ? { by: v.creatorName || v.creatorLogin } : {}),
          ...(v.tags ? { tags: v.tags } : {}),
          ...(v.retracted ? { retracted: true } : {}),
        }));
        return stash(mapEnvironment(accountId, this.org, e, this.envUrl(a!, b!)), {
          [DETAIL_KEYS.revisions]: rows,
        });
      }
      case "access-token": {
        const t = (
          await puPaged<PuToken>(this.ctx, `/api/orgs/${enc(this.org)}/tokens`, "tokens")
        ).find((x) => x.id === id);
        if (!t) throw new PulumiApiError(404, `Pulumi Cloud plugin: token ${id} not found`);
        return mapToken(accountId, this.org, t);
      }
      case "team":
        return mapTeam(
          accountId,
          this.org,
          await puFetch<PuTeam>(this.ctx, `/api/orgs/${enc(this.org)}/teams/${enc(id)}`),
        );
      case "webhook": {
        const w = await puFetch<PuWebhook>(this.ctx, `/api/orgs/${enc(this.org)}/hooks/${enc(id)}`);
        return mapWebhook(accountId, this.org, { ...w, name: w.name || id });
      }
      case "policy-pack": {
        const res = await puFetch<{ policyPacks?: PuPolicyPack[] }>(
          this.ctx,
          `/api/orgs/${enc(this.org)}/policypacks`,
        );
        const p = res?.policyPacks?.find((x) => x.name === id);
        if (!p) throw new PulumiApiError(404, `Pulumi Cloud plugin: policy pack ${id} not found`);
        return mapPolicyPack(accountId, this.org, p);
      }
      case "policy-group": {
        const res = await puFetch<{ policyGroups?: PuPolicyGroup[] }>(
          this.ctx,
          `/api/orgs/${enc(this.org)}/policygroups`,
        );
        const g = res?.policyGroups?.find((x) => x.name === id);
        if (!g) throw new PulumiApiError(404, `Pulumi Cloud plugin: policy group ${id} not found`);
        const stacks = (await this.stacks().catch(() => [] as PuStackSummary[])).map((s) => ({
          id: `${s.projectName}/${s.stackName}`,
          name: `${s.projectName}/${s.stackName}`,
        }));
        return stash(mapPolicyGroup(accountId, this.org, g), { [DETAIL_KEYS.stacks]: stacks });
      }
      default:
        throw new Error(`Pulumi Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  private async stackDetail(
    accountId: string,
    project: string,
    stack: string,
  ): Promise<ResourceInstance> {
    const path = this.sp(project, stack);
    const [s, count, drift, outputs, history, schedules, settings] = await Promise.all([
      puFetch<PuStack>(this.ctx, path),
      puFetch<{ resourceCount?: number }>(this.ctx, `${path}/resources/count`).catch(
        () => undefined,
      ),
      puFetch<{ driftDetected?: boolean }>(this.ctx, `${path}/drift/status`).catch(() => undefined),
      puFetch<{ outputs?: Record<string, unknown> }>(this.ctx, `${path}/outputs`).catch(
        () => undefined,
      ),
      puFetch<{ updates?: PuUpdate[] }>(this.ctx, `${path}/updates`, {
        query: { page: 1, pageSize: 15, "output-type": "service" },
      }).catch(() => undefined),
      puFetch<{ schedules?: Array<Record<string, unknown>> }>(
        this.ctx,
        `${path}/deployments/schedules`,
      ).catch(() => undefined),
      puFetch<Record<string, unknown>>(this.ctx, `${path}/deployments/settings`).catch(
        () => undefined,
      ),
    ]);
    const updates: UpdateRow[] = (history?.updates ?? []).map((u) => {
      const ch = u.resourceChanges ?? {};
      const changes = ["create", "update", "delete", "replace"]
        .filter((k) => ch[k])
        .map((k) => `${ch[k]} ${k}`)
        .join(", ");
      return {
        ...(u.version !== undefined ? { version: u.version } : {}),
        ...(u.kind ? { kind: u.kind } : {}),
        ...(u.result ? { result: u.result } : {}),
        start: unixIso(u.startTime),
        ...(u.startTime && u.endTime ? { durationSecs: u.endTime - u.startTime } : {}),
        ...(u.message ? { message: u.message } : {}),
        ...(changes ? { changes } : {}),
      };
    });
    const scheduleRows: ScheduleRow[] = (schedules?.schedules ?? []).map((x) => {
      const def = (x["definition"] ?? {}) as { request?: { operation?: string } };
      return {
        id: String(x["id"]),
        ...(x["scheduleCron"] ? { cron: String(x["scheduleCron"]) } : {}),
        ...(x["scheduleOnce"] ? { once: String(x["scheduleOnce"]) } : {}),
        ...(def.request?.operation ? { operation: def.request.operation } : {}),
        paused: x["paused"] === true,
        ...(x["nextExecution"] ? { next: String(x["nextExecution"]) } : {}),
        ...(x["lastExecuted"] ? { last: String(x["lastExecuted"]) } : {}),
      };
    });
    const sc = settings?.["sourceContext"] as
      { git?: { repoURL?: string; branch?: string; repoDir?: string } } | undefined;
    const op = (settings?.["operationContext"] as { operation?: string } | undefined)?.operation;
    const latest = history?.updates?.[0];
    const r = mapStack(
      accountId,
      {
        ...s,
        resourceCount: count?.resourceCount ?? latest?.resourceCount,
        lastUpdate: latest?.endTime ?? latest?.startTime,
      } as PuStackSummary & Partial<PuStack>,
      this.stackUrl(project, stack),
      {
        driftDetected: drift?.driftDetected,
        outputCount: outputs?.outputs ? Object.keys(outputs.outputs).length : undefined,
        repo: sc?.git?.repoURL,
      },
    );
    return stash(r, {
      [DETAIL_KEYS.updates]: updates,
      [DETAIL_KEYS.schedules]: scheduleRows,
      [DETAIL_KEYS.settings]: settings
        ? { repo: sc?.git?.repoURL, branch: sc?.git?.branch, dir: sc?.git?.repoDir, operation: op }
        : undefined,
    });
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const id = externalIdOf(resourceId);
    const [a, b, c] = parts(id);
    if (typeId === "stack-output" && outputKey === "value") {
      const path = this.sp(a!, b!);
      const res = await puFetch<{
        outputs?: Record<string, unknown>;
        secretsProviders?: { type?: string };
      }>(this.ctx, `${path}/outputs`);
      const value = res?.outputs?.[c ?? ""];
      if (value === undefined)
        throw new Error(`Pulumi Cloud plugin: output "${c}" is not in the stack's latest update`);
      if (!isSecretValue(value)) return outputText(value);
      if (typeof value.plaintext === "string")
        return outputText(decodePlaintextJson(value.plaintext));
      const provider = res?.secretsProviders?.type;
      if (provider && provider !== "service") {
        throw new Error(
          `This secret is encrypted with the stack's "${provider}" secrets provider, which Pulumi Cloud cannot decrypt. Only stacks using Pulumi Cloud's own secrets provider can be read here.`,
        );
      }
      const dec = await puFetch<{ plaintext?: string | string[] }>(this.ctx, `${path}/decrypt`, {
        method: "POST",
        body: { ciphertext: value.ciphertext },
      });
      const plain = Array.isArray(dec?.plaintext) ? dec.plaintext[0] : dec?.plaintext;
      if (typeof plain !== "string")
        throw new Error("Pulumi Cloud did not return the decrypted value");
      return outputText(decodePlaintext(plain));
    }
    if (
      typeId === "environment" &&
      (outputKey === "values" || outputKey === "environmentVariables")
    ) {
      const base = `/api/esc/environments/${enc(this.org)}/${enc(a!)}/${enc(b!)}`;
      const open = await puFetch<{ id?: string }>(this.ctx, `${base}/open`, {
        method: "POST",
        query: { duration: "5m" },
      });
      if (!open?.id) throw new Error("Pulumi Cloud did not open the environment");
      const env = await puFetch<{ properties?: Record<string, unknown> }>(
        this.ctx,
        `${base}/open/${enc(open.id)}`,
      );
      const values = unwrapEscValue(env?.properties ?? env) as Record<string, unknown>;
      if (outputKey === "values") return JSON.stringify(values);
      const vars = (values?.["environmentVariables"] ?? {}) as Record<string, unknown>;
      return Object.entries(vars)
        .map(([k, v]) => `${k}=${outputText(v)}`)
        .join("\n");
    }
    if (typeId === "access-token" && outputKey === "token") {
      const v = await this.secrets?.getPlaintext(resourceId, "token");
      if (v) return v;
      throw new Error(
        "Pulumi only shows a token when it is created. This one was not created from Infrawrench; create a new one.",
      );
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    const v = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    if (v !== undefined) return String(v);
    throw new Error(
      `Pulumi Cloud plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, logs, cost
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId !== "stack" && resourceTypeId !== "organization") return [];
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");
    if (resourceTypeId === "organization") {
      return [
        { label: "Stacks", value: n(f["stackCount"]) },
        { label: "RUM", value: n(f["resourcesUnderManagement"]) },
      ];
    }
    return [
      { label: "Resources", value: n(f["resourceCount"]) },
      {
        label: "Drift",
        value:
          f["driftDetected"] === true ? "Detected" : f["driftDetected"] === false ? "None" : "—",
        variant: f["driftDetected"] === true ? "status-degraded" : "default",
      },
    ];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
    if (resourceTypeId === "organization")
      return usageSeries(this.ctx, this.org, range.startMs, range.endMs);
    if (resourceTypeId === "stack") {
      const [p, s] = parts(externalIdOf(resourceId));
      const updates: PuUpdate[] = [];
      for (let page = 1; page <= 5; page++) {
        const res = await puFetch<{ updates?: PuUpdate[] }>(
          this.ctx,
          `${this.sp(p!, s!)}/updates`,
          {
            query: { page, pageSize: 100 },
          },
        );
        const batch = res?.updates ?? [];
        updates.push(...batch);
        if (batch.length < 100 || batch.some((u) => (u.startTime ?? 0) * 1000 < range.startMs))
          break;
      }
      return updateSeries(updates, range.startMs, range.endMs);
    }
    return [];
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "deployment") throw new Error(`Pulumi Cloud plugin: no logs for "${typeId}"`);
    const [p, s, id] = parts(externalIdOf(resourceId));
    const lines: string[] = [];
    let token: string | undefined;
    for (let i = 0; i < MAX_LOG_PAGES; i++) {
      const res = await puFetch<{
        lines?: Array<{ header?: string; line?: string }>;
        nextToken?: string;
      }>(this.ctx, `${this.sp(p!, s!)}/deployments/${enc(id!)}/logs`, {
        query: token ? { continuationToken: token } : {},
      });
      for (const l of res?.lines ?? []) {
        if (l.header) lines.push(`== ${l.header}`);
        if (l.line !== undefined)
          lines.push(l.line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\n$/, ""));
      }
      if (!res?.nextToken || res.nextToken === token) break;
      token = res.nextToken;
    }
    return {
      text: tailLines(lines.join("\n"), Math.max(1, params.tailLines ?? 500)),
      containers: [],
      activeContainer: "",
    };
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchUsageCost(this.ctx, this.org, this.rates, range);
  }

  // -------------------------------------------------------------------------
  // Steps editors: deployment settings (stack) and ESC definitions
  // -------------------------------------------------------------------------

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const typeId = resourceId.split(":")[1];
    const [a, b] = parts(externalIdOf(resourceId));
    if (typeId === "environment") {
      return puRaw(this.ctx, `/api/esc/environments/${enc(this.org)}/${enc(a!)}/${enc(b!)}`, {
        accept: "application/x-yaml",
      });
    }
    if (typeId === "stack") {
      try {
        const settings = await puFetch<Record<string, unknown>>(
          this.ctx,
          `${this.sp(a!, b!)}/deployments/settings`,
        );
        return `${JSON.stringify(settings, null, 2)}\n`;
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
        return `${JSON.stringify(
          {
            sourceContext: {
              git: {
                repoURL: "https://github.com/acme/infra.git",
                branch: "refs/heads/main",
                repoDir: ".",
              },
            },
            operationContext: { operation: "update", preRunCommands: [], environmentVariables: {} },
          },
          null,
          2,
        )}\n`;
      }
    }
    throw new Error(`Pulumi Cloud plugin: nothing to edit for "${typeId}"`);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const typeId = resourceId.split(":")[1];
    const [a, b] = parts(externalIdOf(resourceId));
    if (typeId === "environment") {
      const res = await puFetch<{ diagnostics?: Array<{ summary?: string; path?: string }> }>(
        this.ctx,
        `/api/esc/environments/${enc(this.org)}/${enc(a!)}/${enc(b!)}`,
        { method: "PATCH", body: manifest, yaml: true },
      );
      const diags = res?.diagnostics ?? [];
      if (diags.length > 0) {
        throw new Error(
          `ESC rejected the definition: ${diags.map((d) => `${d.path ? `${d.path}: ` : ""}${d.summary}`).join("; ")}`,
        );
      }
      return;
    }
    if (typeId === "stack") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(manifest) as Record<string, unknown>;
      } catch {
        throw new Error("Pulumi Cloud plugin: deployment settings must be JSON");
      }
      delete body["version"];
      delete body["source"];
      await puFetch(this.ctx, `${this.sp(a!, b!)}/deployments/settings`, { method: "PUT", body });
      return;
    }
    throw new Error(`Pulumi Cloud plugin: nothing to edit for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  private async stackOptions(): Promise<Array<{ id: string; label: string }>> {
    return (await this.stacks().catch(() => [] as PuStackSummary[]))
      .map((s) => ({
        id: `${s.projectName}/${s.stackName}`,
        label: `${s.projectName}/${s.stackName}`,
      }))
      .sort((x, y) => x.label.localeCompare(y.label));
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "stack": {
        const projects = [
          ...new Set(
            (await this.stacks().catch(() => [] as PuStackSummary[])).map((s) => s.projectName),
          ),
        ].sort();
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "project",
                    label: "Project",
                    kind: "text" as const,
                    required: true,
                    ...(projects[0] ? { defaultValue: projects[0] } : {}),
                    description:
                      projects.length > 0
                        ? `Existing projects: ${projects.join(", ")}`
                        : "The Pulumi project name from Pulumi.yaml.",
                  },
                ]),
            {
              key: "stackName",
              label: "Stack name",
              kind: "text",
              required: true,
              placeholder: "staging",
            },
          ],
        };
      }
      case "deployment": {
        const stacks = parentResourceId ? [] : await this.stackOptions();
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
                    ...(stacks[0] ? { defaultValue: stacks[0].id } : {}),
                    options: stacks,
                  },
                ]),
            {
              key: "operation",
              label: "Operation",
              kind: "select",
              required: true,
              defaultValue: "update",
              options: OPERATIONS,
            },
          ],
        };
      }
      case "environment":
        return {
          fields: [
            {
              key: "project",
              label: "Project",
              kind: "text",
              required: true,
              defaultValue: "default",
            },
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "aws-prod" },
          ],
        };
      case "access-token":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "ci" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "admin",
              label: "Access",
              kind: "select",
              required: true,
              defaultValue: "false",
              options: [
                { id: "false", label: "Member" },
                { id: "true", label: "Admin", description: "Can manage the organization." },
              ],
            },
            {
              key: "expiresDays",
              label: "Expires after (days)",
              kind: "number",
              required: false,
              defaultValue: "90",
              minValue: 0,
              maxValue: 730,
              description: "0 for a token that never expires.",
            },
          ],
        };
      case "team":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "platform" },
            {
              key: "displayName",
              label: "Display name",
              kind: "text",
              required: true,
              placeholder: "Platform",
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "webhook":
        return {
          fields: [
            {
              key: "displayName",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Deploys to Slack",
            },
            {
              key: "payloadUrl",
              label: "Payload URL",
              kind: "text",
              required: true,
              placeholder: "https://hooks.slack.com/services/...",
            },
            {
              key: "format",
              label: "Format",
              kind: "select",
              required: true,
              defaultValue: "raw",
              options: [
                { id: "raw", label: "JSON" },
                { id: "slack", label: "Slack" },
                { id: "ms_teams", label: "Microsoft Teams" },
              ],
            },
            {
              key: "groups",
              label: "Event groups",
              kind: "text",
              required: false,
              placeholder: "stacks, deployments",
              description: "Comma-separated. Empty sends every event.",
            },
            { key: "secret", label: "Signing secret", kind: "password", required: false },
          ],
        };
      case "policy-group":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "production" },
            {
              key: "mode",
              label: "Mode",
              kind: "select",
              required: true,
              defaultValue: "preventative",
              options: [
                {
                  id: "preventative",
                  label: "Preventative",
                  description: "Mandatory policies block updates.",
                },
                { id: "audit", label: "Audit", description: "Violations are reported only." },
              ],
            },
          ],
        };
      default:
        throw new Error(`Pulumi Cloud plugin: cannot create "${typeId}" from Infrawrench`);
    }
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
      if (!v) throw new Error(`Pulumi Cloud plugin: "${label}" is required`);
      return v;
    };
    const opt = (key: string) => (fields[key] ?? "").trim();
    switch (typeId) {
      case "stack": {
        const project = opt("project") || parent || need("project", "Project");
        const stackName = need("stackName", "Stack name");
        await puFetch(this.ctx, `/api/stacks/${enc(this.org)}/${enc(project)}`, {
          method: "POST",
          body: { stackName },
        });
        this.stacksCache = undefined;
        return mapStack(
          accountId,
          { orgName: this.org, projectName: project, stackName, resourceCount: 0 },
          this.stackUrl(project, stackName),
        );
      }
      case "deployment": {
        const [project, stack] = parts(opt("stack") || parent || need("stack", "Stack"));
        const res = await puFetch<{ id?: string; version?: number }>(
          this.ctx,
          `${this.sp(project!, stack!)}/deployments`,
          {
            method: "POST",
            body: { operation: opt("operation") || "update", inheritSettings: true },
          },
        );
        if (!res?.id) throw new Error("Pulumi Cloud did not start a deployment");
        return mapDeployment(
          accountId,
          {
            id: res.id,
            ...(res.version !== undefined ? { version: res.version } : {}),
            status: "not-started",
            pulumiOperation: opt("operation") || "update",
            projectName: project!,
            stackName: stack!,
            created: new Date().toISOString(),
          },
          this.stackUrl(project!, stack!),
        );
      }
      case "environment": {
        const project = need("project", "Project");
        const name = need("name", "Name");
        await puFetch(this.ctx, `/api/esc/environments/${enc(this.org)}`, {
          method: "POST",
          body: { project, name },
        });
        return mapEnvironment(accountId, this.org, { name, project }, this.envUrl(project, name));
      }
      case "access-token": {
        const days = Number(opt("expiresDays") || "0");
        if (!Number.isFinite(days) || days < 0)
          throw new Error("Pulumi Cloud plugin: expiry must be a number of days");
        const res = await puFetch<{ id?: string; tokenValue?: string }>(
          this.ctx,
          `/api/orgs/${enc(this.org)}/tokens`,
          {
            method: "POST",
            body: {
              name: need("name", "Name"),
              description: opt("description"),
              admin: bool(fields["admin"]),
              expires: days > 0 ? Math.floor(Date.now() / 1000) + Math.round(days * 86400) : 0,
            },
          },
        );
        if (!res?.id) throw new Error("Pulumi Cloud did not create the token");
        const resource = mapToken(accountId, this.org, {
          id: res.id,
          name: opt("name"),
          description: opt("description"),
          admin: bool(fields["admin"]),
          created: new Date().toISOString(),
          type: "organization",
          ...(days > 0
            ? { expires: Math.floor(Date.now() / 1000) + Math.round(days * 86400) }
            : {}),
        });
        const warnings = [];
        if (res.tokenValue && this.secrets?.setPlaintext) {
          await this.secrets.setPlaintext(resource.id, "token", res.tokenValue);
        } else {
          warnings.push({
            code: "token-not-kept",
            message:
              "The token was created, but its value could not be kept: Pulumi shows it only once. Revoke it and create another.",
          });
        }
        return { resource, warnings };
      }
      case "team": {
        const t = await puFetch<PuTeam>(this.ctx, `/api/orgs/${enc(this.org)}/teams/pulumi`, {
          method: "POST",
          body: {
            name: need("name", "Name"),
            displayName: need("displayName", "Display name"),
            description: opt("description"),
          },
        });
        return mapTeam(
          accountId,
          this.org,
          t ?? { name: opt("name"), displayName: opt("displayName") },
        );
      }
      case "webhook": {
        const displayName = need("displayName", "Name");
        const w = await puFetch<PuWebhook>(this.ctx, `/api/orgs/${enc(this.org)}/hooks`, {
          method: "POST",
          body: {
            organizationName: this.org,
            displayName,
            payloadUrl: need("payloadUrl", "Payload URL"),
            active: true,
            format: opt("format") || "raw",
            groups: list(fields["groups"]),
            ...(fields["secret"] ? { secret: fields["secret"] } : {}),
          },
        });
        return mapWebhook(
          accountId,
          this.org,
          w ?? { displayName, payloadUrl: opt("payloadUrl"), active: true },
        );
      }
      case "policy-group": {
        const name = need("name", "Name");
        await puFetch(this.ctx, `/api/orgs/${enc(this.org)}/policygroups`, {
          method: "POST",
          body: { name, entityType: "stacks", mode: opt("mode") || "preventative" },
        });
        return mapPolicyGroup(accountId, this.org, {
          name,
          entityType: "stacks",
          mode: opt("mode") || "preventative",
        });
      }
      default:
        throw new Error(`Pulumi Cloud plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "team": {
        const body: Record<string, unknown> = {};
        if ("displayName" in fields) body["newDisplayName"] = (fields["displayName"] ?? "").trim();
        if ("description" in fields) body["newDescription"] = (fields["description"] ?? "").trim();
        if (Object.keys(body).length > 0) {
          await puFetch(this.ctx, `/api/orgs/${enc(this.org)}/teams/${enc(id)}`, {
            method: "PATCH",
            body,
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "webhook": {
        const current = await puFetch<PuWebhook>(
          this.ctx,
          `/api/orgs/${enc(this.org)}/hooks/${enc(id)}`,
        );
        const body: Record<string, unknown> = {
          organizationName: this.org,
          name: id,
          displayName:
            "displayName" in fields ? (fields["displayName"] ?? "").trim() : current.displayName,
          payloadUrl:
            "payloadUrl" in fields ? (fields["payloadUrl"] ?? "").trim() : current.payloadUrl,
          active: "active" in fields ? bool(fields["active"]) : current.active,
          format: "format" in fields ? fields["format"] || "raw" : current.format || "raw",
          groups: "groups" in fields ? list(fields["groups"]) : (current.groups ?? []),
          filters: "filters" in fields ? list(fields["filters"]) : (current.filters ?? []),
          ...(fields["secret"] ? { secret: fields["secret"] } : {}),
        };
        await puFetch(this.ctx, `/api/orgs/${enc(this.org)}/hooks/${enc(id)}`, {
          method: "PATCH",
          body,
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "policy-group": {
        const newName = (fields["name"] ?? "").trim();
        if (newName && newName !== id) {
          await puFetch(this.ctx, `/api/orgs/${enc(this.org)}/policygroups/${enc(id)}`, {
            method: "PATCH",
            body: { newName },
          });
          return this.getResource(typeId, `${accountId}:policy-group:${newName}`, accountId);
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Pulumi Cloud plugin: cannot edit "${typeId}" from Infrawrench`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const [a, b] = parts(id);
    const del = (path: string) => puFetch(this.ctx, path, { method: "DELETE" });
    switch (typeId) {
      case "stack":
        // No `force`: Pulumi refuses to delete a stack that still has resources.
        await del(this.sp(a!, b!));
        this.stacksCache = undefined;
        return;
      case "environment":
        await del(`/api/esc/environments/${enc(this.org)}/${enc(a!)}/${enc(b!)}`);
        return;
      case "access-token":
        await del(`/api/orgs/${enc(this.org)}/tokens/${enc(id)}`);
        return;
      case "team":
        await del(`/api/orgs/${enc(this.org)}/teams/${enc(id)}`);
        return;
      case "webhook":
        await del(`/api/orgs/${enc(this.org)}/hooks/${enc(id)}`);
        return;
      case "policy-pack":
        await del(`/api/orgs/${enc(this.org)}/policypacks/${enc(id)}`);
        return;
      case "policy-group":
        await del(`/api/orgs/${enc(this.org)}/policygroups/${enc(id)}`);
        return;
      default:
        throw new Error(`Pulumi Cloud plugin: cannot delete "${typeId}" from Infrawrench`);
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
    const [a, b, c] = parts(id);
    if (typeId === "deployment" && actionId === "cancel") {
      await puFetch(this.ctx, `${this.sp(a!, b!)}/deployments/${enc(c!)}/cancel`, {
        method: "POST",
      });
      return;
    }
    if (typeId === "stack") {
      const [verb, scheduleId] = actionId.split(":");
      const base = `${this.sp(a!, b!)}/deployments/schedules/${enc(scheduleId ?? "")}`;
      if (verb === "schedule-pause" || verb === "schedule-resume") {
        await puFetch(this.ctx, `${base}/${verb === "schedule-pause" ? "pause" : "resume"}`, {
          method: "POST",
        });
        return;
      }
      if (verb === "schedule-delete") {
        await puFetch(this.ctx, base, { method: "DELETE" });
        return;
      }
    }
    if (typeId === "environment" && actionId.startsWith("rollback:")) {
      const version = actionId.split(":")[1];
      const yaml = await puRaw(
        this.ctx,
        `/api/esc/environments/${enc(this.org)}/${enc(a!)}/${enc(b!)}/versions/${enc(version ?? "")}`,
        {
          accept: "application/x-yaml",
        },
      );
      await puFetch(this.ctx, `/api/esc/environments/${enc(this.org)}/${enc(a!)}/${enc(b!)}`, {
        method: "PATCH",
        body: yaml,
        yaml: true,
      });
      return;
    }
    if (typeId === "webhook") {
      if (actionId === "ping") {
        await puFetch(this.ctx, `/api/orgs/${enc(this.org)}/hooks/${enc(id)}/ping`, {
          method: "POST",
        });
        return;
      }
      if (actionId === "enable" || actionId === "disable") {
        const current = await puFetch<PuWebhook>(
          this.ctx,
          `/api/orgs/${enc(this.org)}/hooks/${enc(id)}`,
        );
        await puFetch(this.ctx, `/api/orgs/${enc(this.org)}/hooks/${enc(id)}`, {
          method: "PATCH",
          body: {
            organizationName: this.org,
            name: id,
            displayName: current.displayName,
            payloadUrl: current.payloadUrl,
            format: current.format || "raw",
            groups: current.groups ?? [],
            filters: current.filters ?? [],
            active: actionId === "enable",
          },
        });
        return;
      }
    }
    throw new Error(`Pulumi Cloud plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const id = externalIdOf(resourceId);
    const [a, b] = parts(id);
    const vals = parseFormArg(args[0]);
    switch (command) {
      case "deploy":
        if (typeId !== "stack") break;
        await puFetch(this.ctx, `${this.sp(a!, b!)}/deployments`, {
          method: "POST",
          body: { operation: vals["operation"] || "update", inheritSettings: true },
        });
        return null;
      case "schedule": {
        if (typeId !== "stack") break;
        const cron = (vals["cron"] ?? "").trim();
        const once = (vals["once"] ?? "").trim();
        if (!cron && !once) throw new Error("Pulumi Cloud plugin: give a cron schedule or a time");
        await puFetch(this.ctx, `${this.sp(a!, b!)}/deployments/schedules`, {
          method: "POST",
          body: {
            request: { operation: vals["operation"] || "detect-drift", inheritSettings: true },
            ...(cron ? { scheduleCron: cron } : { scheduleOnce: new Date(once).toISOString() }),
          },
        });
        return null;
      }
      case "rename": {
        if (typeId !== "stack") break;
        const newName = (vals["newName"] ?? "").trim();
        const newProject = (vals["newProject"] ?? "").trim() || a!;
        if (!newName) throw new Error("Pulumi Cloud plugin: give the new stack name");
        await puFetch(this.ctx, `${this.sp(a!, b!)}/rename`, {
          method: "POST",
          body: { newName, newProject },
        });
        this.stacksCache = undefined;
        return null;
      }
      case "tagRevision": {
        if (typeId !== "environment") break;
        const tag = (vals["tag"] ?? "").trim();
        const revision = Number(vals["revision"]);
        if (!tag || !Number.isInteger(revision))
          throw new Error("Pulumi Cloud plugin: give a tag and a revision");
        const base = `/api/esc/environments/${enc(this.org)}/${enc(a!)}/${enc(b!)}/versions/tags`;
        try {
          await puFetch(this.ctx, base, { method: "POST", body: { name: tag, revision } });
        } catch (err) {
          if (statusOf(err) !== 409) throw err;
          await puFetch(this.ctx, `${base}/${enc(tag)}`, { method: "PATCH", body: { revision } });
        }
        return null;
      }
      case "groupStack": {
        if (typeId !== "policy-group") break;
        const [project, stack] = parts(vals["stack"] ?? "");
        if (!project || !stack) throw new Error("Pulumi Cloud plugin: choose a stack");
        const ref = { name: stack, routingProject: project };
        await puFetch(this.ctx, `/api/orgs/${enc(this.org)}/policygroups/${enc(id)}`, {
          method: "PATCH",
          body: vals["op"] === "remove" ? { removeStack: ref } : { addStack: ref },
        });
        return null;
      }
    }
    throw new Error(`Pulumi Cloud plugin: unknown command "${command}" for "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderPulumiDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderPulumiSidebar(resource);
  }
}

/** A secret output the API already returned decrypted (`plaintext` is the JSON-encoded value). */
function decodePlaintextJson(plain: string): unknown {
  try {
    return JSON.parse(plain);
  } catch {
    return plain;
  }
}
