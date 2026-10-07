import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { PostHogContext } from "./api.js";
import { pagedList, phFetch, resolveHost, statusOf } from "./api.js";
import { fetchPostHogCost, spendSeries } from "./cost-data.js";
import type { Obj } from "./mappers.js";
import {
  LEVEL_IDS,
  instance,
  mapMember,
  mapProject,
  mapProjectObject,
  splitScoped,
} from "./mappers.js";
import { verifyPostHogCredentials } from "./preflight.js";
import { eventSeries, hogqlString, rangeOrDefault, runHogQL } from "./query.js";
import { BASE_KEY, renderPostHogDetail, renderPostHogSidebar } from "./render.js";
import { PROJECT_ROUTES } from "./resource-types.js";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Set the first release condition's rollout, creating one if the flag has none. */
export function withRollout(filters: Obj, rollout: number): Obj {
  const groups =
    Array.isArray(filters.groups) && filters.groups.length
      ? [...(filters.groups as Obj[])]
      : [{ properties: [] }];
  groups[0] = { ...groups[0], rollout_percentage: rollout };
  return { ...filters, groups };
}

/** Organizations the key can see, for the organization picker. */
export async function listOrganizations(ctx: PostHogContext): Promise<Obj[]> {
  return pagedList<Obj>(ctx, "/api/organizations/");
}

export class PostHogClient implements PluginClient {
  private readonly ctx: PostHogContext;
  private readonly orgSetting: string;
  private orgIdPromise: Promise<string> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("PostHog plugin: missing apiKey credential");
    const { baseUrl, region } = resolveHost(
      credentials["region"] ?? "us",
      credentials["host"] ?? "",
    );
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      baseUrl,
      region,
      apiKey,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.orgSetting = (credentials["organizationId"] ?? "").trim();
  }

  get context(): PostHogContext {
    return this.ctx;
  }

  /** The picked organization, else the key's current one. */
  private orgId(): Promise<string> {
    if (!this.orgIdPromise) {
      this.orgIdPromise = (async () => {
        if (this.orgSetting) return this.orgSetting;
        const org = await phFetch<Obj>(this.ctx, "/api/organizations/@current/");
        return str(org.id);
      })();
      this.orgIdPromise.catch(() => {
        this.orgIdPromise = undefined;
      });
    }
    return this.orgIdPromise;
  }

  private async projects(): Promise<Obj[]> {
    const org = await this.orgId();
    return pagedList<Obj>(this.ctx, `/api/organizations/${encodeURIComponent(org)}/projects/`);
  }

  private route(typeId: string): string {
    const r = PROJECT_ROUTES[typeId];
    if (!r) throw new Error(`PostHog plugin: unknown resource type "${typeId}"`);
    return r;
  }

  private objPath(typeId: string, projectId: string, id?: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}/${this.route(typeId)}/${id ? `${encodeURIComponent(id)}/` : ""}`;
  }

  private map(accountId: string, typeId: string, projectId: string, o: Obj): ResourceInstance {
    return mapProjectObject(accountId, typeId, projectId, o, this.ctx);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  private async organization(accountId: string): Promise<ResourceInstance> {
    const id = await this.orgId();
    const [org, billing] = await Promise.all([
      phFetch<Obj>(this.ctx, `/api/organizations/${encodeURIComponent(id)}/`),
      this.ctx.region === "self-hosted"
        ? Promise.resolve(undefined)
        : phFetch<Obj>(this.ctx, "/api/billing/").catch(() => undefined),
    ]);
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : Number(v));
    const period = billing?.billing_period as Obj | undefined;
    return instance(
      accountId,
      "organization",
      id,
      str(org.name) || id,
      {
        name: org.name,
        slug: org.slug,
        plan: billing?.subscription_level ?? billing?.billing_plan,
        memberCount: org.member_count,
        projectCount: Array.isArray(org.projects) ? org.projects.length : undefined,
        currentTotalUsd: num(
          billing?.current_total_amount_usd_after_discount ?? billing?.current_total_amount_usd,
        ),
        projectedTotalUsd: num(
          billing?.projected_total_amount_usd_after_discount ?? billing?.projected_total_amount_usd,
        ),
        periodEnd: period?.current_period_end,
        region: this.ctx.region,
        createdAt: org.created_at,
      },
      { organizationId: id },
    );
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization":
        return [await this.organization(accountId)];
      case "project":
        return (await this.projects()).map((p) => mapProject(accountId, p, this.ctx));
      case "member": {
        const org = await this.orgId();
        try {
          return (
            await pagedList<Obj>(this.ctx, `/api/organizations/${encodeURIComponent(org)}/members/`)
          ).map((m) => mapMember(accountId, m));
        } catch (err) {
          if (statusOf(err) === 403) return [];
          throw err;
        }
      }
      default: {
        const route = this.route(typeId);
        const projects = await this.projects();
        const lists = await Promise.all(
          projects.map(async (p) => {
            const pid = str(p.id);
            try {
              const items = await pagedList<Obj>(
                this.ctx,
                `/api/projects/${encodeURIComponent(pid)}/${route}/`,
              );
              return items
                .filter((o) => o.deleted !== true)
                .map((o) => this.map(accountId, typeId, pid, o));
            } catch (err) {
              // A key scoped without this object's read scope, or to other projects.
              if (statusOf(err) === 403 || statusOf(err) === 404) return [];
              throw err;
            }
          }),
        );
        return lists.flat();
      }
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId) || resourceId;
    switch (typeId) {
      case "organization":
        return this.organization(accountId);
      case "project": {
        const org = await this.orgId();
        const p = await phFetch<Obj>(
          this.ctx,
          `/api/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(ext)}/`,
        );
        return mapProject(accountId, p, this.ctx);
      }
      case "member": {
        const found = (await this.listResources("member", accountId)).find(
          (m) => m.externalId === ext,
        );
        if (!found) throw new Error(`PostHog plugin: member ${ext} not found`);
        return found;
      }
      default: {
        const [pid, id] = splitScoped(ext);
        return this.map(
          accountId,
          typeId,
          pid,
          await phFetch<Obj>(this.ctx, this.objPath(typeId, pid, id)),
        );
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const r = await this.getResource(typeId, resourceId, accountId);
    const v = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    if (v === undefined)
      throw new Error(`PostHog plugin: cannot resolve "${outputKey}" for "${typeId}"`);
    return String(v);
  }

  // -------------------------------------------------------------------------
  // Metrics, cost, query, preflight
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const ext = externalIdOf(resourceId) || resourceId;
    if (typeId === "organization") {
      return spendSeries(this.ctx, rangeOrDefault(timeRange, 30 * 24 * 3600_000));
    }
    const range = rangeOrDefault(timeRange);
    if (typeId === "project") return eventSeries(this.ctx, ext, range, "Events");
    if (typeId === "feature-flag") {
      const r = await this.getResource(typeId, resourceId, accountId);
      const [pid] = splitScoped(ext);
      return eventSeries(
        this.ctx,
        pid,
        range,
        "Evaluations",
        `event = '$feature_flag_called' AND properties.$feature_flag = ${hogqlString(str(r.fields["key"]))}`,
      );
    }
    return [];
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const names = new Map<string, string>();
    for (const p of await this.projects().catch(() => [] as Obj[]))
      names.set(str(p.id), str(p.name) || str(p.id));
    return fetchPostHogCost(this.ctx, range, names);
  }

  async executeQuery(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const started = Date.now();
    const projectId = externalIdOf(resourceId) || resourceId;
    const { columns, rows } = await runHogQL(this.ctx, projectId, sql);
    return {
      rows: rows.map((r) =>
        Object.fromEntries(
          columns.map((c, i) => {
            const v = r[i];
            return [c, v !== null && typeof v === "object" ? JSON.stringify(v) : v];
          }),
        ),
      ),
      durationMs: Date.now() - started,
    };
  }

  async introspectResource(): Promise<SqlTableMeta[]> {
    return ["events", "persons", "sessions", "groups", "person_distinct_ids"].map((name) => ({
      name,
      columns: [],
    }));
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyPostHogCredentials(
      this.ctx,
      () => this.orgId(),
      () => this.projects(),
    );
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async projectField(): Promise<CreateResourceConfig["fields"][number]> {
    const projects = await this.projects();
    return {
      key: "projectId",
      label: "Project",
      kind: "select",
      required: true,
      options: projects.map((p) => ({ id: str(p.id), label: str(p.name) || str(p.id) })),
      ...(projects[0] ? { defaultValue: str(projects[0].id) } : {}),
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const project = parentResourceId ? undefined : await this.projectField();
    const withProject = (fields: CreateResourceConfig["fields"]): CreateResourceConfig => ({
      fields: project ? [project, ...fields] : fields,
    });
    switch (typeId) {
      case "feature-flag":
        return withProject([
          {
            key: "key",
            label: "Key",
            kind: "text",
            required: true,
            placeholder: "new-checkout",
            description:
              "Used in code. Letters, numbers, hyphens and underscores; cannot be changed later.",
          },
          { key: "name", label: "Description", kind: "text", required: false },
          {
            key: "rolloutPercentage",
            label: "Roll out to (%)",
            kind: "number",
            required: true,
            defaultValue: "0",
            minValue: 0,
            maxValue: 100,
          },
          {
            key: "active",
            label: "Enabled",
            kind: "select",
            required: true,
            defaultValue: "true",
            options: [
              { id: "true", label: "Yes" },
              { id: "false", label: "No" },
            ],
          },
          { key: "tags", label: "Tags", kind: "string-list", required: false },
        ]);
      case "dashboard":
        return withProject([
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
        ]);
      case "annotation":
        return withProject([
          {
            key: "content",
            label: "Note",
            kind: "text",
            required: true,
            placeholder: "Deployed v2.4",
          },
          { key: "dateMarker", label: "When", kind: "datetime", required: true },
          {
            key: "scope",
            label: "Shown on",
            kind: "select",
            required: true,
            defaultValue: "project",
            options: [
              { id: "project", label: "This project" },
              { id: "organization", label: "Every project in the organization" },
            ],
          },
        ]);
      default:
        throw new Error(`PostHog plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const pid = parentResourceId ? externalIdOf(parentResourceId) : str(fields["projectId"]);
    if (!pid) throw new Error("Pick a project.");
    let body: Obj;
    switch (typeId) {
      case "feature-flag": {
        const key = (fields["key"] ?? "").trim();
        if (!/^[A-Za-z0-9_-]+$/.test(key))
          throw new Error("The key may only use letters, numbers, hyphens and underscores.");
        body = {
          key,
          name: fields["name"] ?? "",
          active: fields["active"] !== "false",
          filters: withRollout({ groups: [] }, Number(fields["rolloutPercentage"] || 0)),
          tags: csv(fields["tags"]),
        };
        break;
      }
      case "dashboard":
        body = { name: (fields["name"] ?? "").trim(), description: fields["description"] ?? "" };
        break;
      case "annotation":
        body = {
          content: (fields["content"] ?? "").trim(),
          date_marker: new Date(fields["dateMarker"] ?? "").toISOString(),
          scope: fields["scope"] || "project",
        };
        break;
      default:
        throw new Error(`PostHog plugin: cannot create "${typeId}" from Infrawrench`);
    }
    const created = await phFetch<Obj>(this.ctx, this.objPath(typeId, pid), {
      method: "POST",
      body: JSON.stringify(body),
    });
    return this.map(accountId, typeId, pid, created);
  }

  // -------------------------------------------------------------------------
  // Update / delete / actions
  // -------------------------------------------------------------------------

  private patch(typeId: string, pid: string, id: string, body: Obj): Promise<Obj> {
    return phFetch<Obj>(this.ctx, this.objPath(typeId, pid, id), {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId) || resourceId;
    if (typeId === "member") {
      const level = LEVEL_IDS[fields["level"] ?? ""];
      if (level !== undefined) {
        const org = await this.orgId();
        await phFetch(
          this.ctx,
          `/api/organizations/${encodeURIComponent(org)}/members/${encodeURIComponent(ext)}/`,
          {
            method: "PATCH",
            body: JSON.stringify({ level }),
          },
        );
      }
      return this.getResource(typeId, resourceId, accountId);
    }
    const [pid, id] = splitScoped(ext);
    const body: Obj = {};
    const has = (k: string) => k in fields;
    switch (typeId) {
      case "feature-flag": {
        if (has("name")) body.name = fields["name"] ?? "";
        if (has("active")) body.active = fields["active"] === "true";
        if (has("tags")) body.tags = csv(fields["tags"]);
        if (has("rolloutPercentage") && fields["rolloutPercentage"] !== "") {
          const rollout = Number(fields["rolloutPercentage"]);
          if (!Number.isFinite(rollout) || rollout < 0 || rollout > 100)
            throw new Error("Rollout must be between 0 and 100.");
          const current = await phFetch<Obj>(this.ctx, this.objPath(typeId, pid, id));
          body.filters = withRollout((current.filters as Obj) ?? {}, rollout);
        }
        break;
      }
      case "dashboard":
        if (fields["name"]?.trim()) body.name = fields["name"].trim();
        if (has("description")) body.description = fields["description"] ?? "";
        if (has("pinned")) body.pinned = fields["pinned"] === "true";
        if (has("tags")) body.tags = csv(fields["tags"]);
        break;
      case "experiment":
      case "cohort":
      case "insight":
      case "action":
        if (fields["name"]?.trim()) body.name = fields["name"].trim();
        if (has("description")) body.description = fields["description"] ?? "";
        break;
      case "annotation":
        if (fields["content"]?.trim()) body.content = fields["content"].trim();
        break;
      default:
        throw new Error(`PostHog plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
    if (Object.keys(body).length > 0) await this.patch(typeId, pid, id, body);
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const ext = externalIdOf(resourceId) || resourceId;
    if (typeId === "member") {
      const org = await this.orgId();
      await phFetch(
        this.ctx,
        `/api/organizations/${encodeURIComponent(org)}/members/${encodeURIComponent(ext)}/`,
        { method: "DELETE" },
      );
      return;
    }
    if (typeId === "organization" || typeId === "project") {
      throw new Error(`PostHog plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
    const [pid, id] = splitScoped(ext);
    // Batch exports are the one type with a real DELETE; everything else is a
    // soft delete ("Hard delete of this model is not allowed").
    if (typeId === "batch-export") {
      await phFetch(this.ctx, this.objPath(typeId, pid, id), { method: "DELETE" });
      return;
    }
    await this.patch(typeId, pid, id, { deleted: true });
  }

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const [pid, id] = splitScoped(externalIdOf(resourceId) || resourceId);
    const post = (action: string, body: Obj = {}) =>
      phFetch(this.ctx, `${this.objPath(typeId, pid, id)}${action}/`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    switch (`${typeId}:${actionId}`) {
      case "feature-flag:enable":
      case "feature-flag:disable":
        await post(actionId);
        return;
      case "feature-flag:rollout-all":
        await post("roll_out_to_everyone");
        return;
      case "experiment:launch":
      case "experiment:pause":
      case "experiment:resume":
      case "experiment:archive":
        await post(actionId);
        return;
      case "experiment:end":
        await post("end", {});
        return;
      case "batch-export:pause":
      case "batch-export:unpause":
        await post(actionId);
        return;
      case "hog-function:enable":
      case "hog-function:disable":
        await this.patch(typeId, pid, id, { enabled: actionId === "enable" });
        return;
      default:
        throw new Error(`PostHog plugin: unknown action "${actionId}" for "${typeId}"`);
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderPostHogDetail({
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, [BASE_KEY]: this.ctx.baseUrl },
    });
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderPostHogSidebar(resource);
  }
}
