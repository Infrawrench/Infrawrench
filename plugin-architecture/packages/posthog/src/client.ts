import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
import {
  externalIdOf,
  pathEncode,
  rethrowIncompleteList,
  unencodedSegment,
} from "@infrawrench/plugin-base";
import type {
  FlagFilters,
  ObjectPatches,
  PostHogContext,
  ProjectObjects,
  ProjectObjectType,
  SoftDeletedType,
} from "./api.js";
import {
  OBJECTS,
  PATCHES,
  createPostHogContext,
  isProjectObjectType,
  listRouteRequest,
  resolveHost,
  statusOf,
} from "./api.js";
import { fetchPostHogCost, spendSeries } from "./cost-data.js";
import {
  LEVEL_IDS,
  ROLLOUT_ACTION,
  instance,
  mapMember,
  mapProject,
  mapProjectObject,
  splitScoped,
  variantKeys,
} from "./mappers.js";
import { verifyPostHogCredentials } from "./preflight.js";
import { eventSeries, hogqlString, rangeOrDefault, runHogQL } from "./query.js";
import { BASE_KEY, renderPostHogDetail, renderPostHogSidebar } from "./render.js";

const str = (v: string | number | boolean | null | undefined): string =>
  v === undefined || v === null ? "" : String(v);
const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Set the first release condition's rollout, creating one if the flag has none. */
export function withRollout(filters: FlagFilters, rollout: number): FlagFilters {
  const groups: NonNullable<FlagFilters["groups"]> =
    Array.isArray(filters.groups) && filters.groups.length
      ? [...filters.groups]
      : [{ properties: [] }];
  groups[0] = { ...groups[0], rollout_percentage: rollout };
  return { ...filters, groups };
}

/**
 * What a write to a flag sends so PostHog can refuse it if the flag has moved on, and
 * which it needs for a flag whose `filters.version` is 2. A flag from before
 * versioning reads as null, which a PATCH does not take.
 */
function versionOf(flag: { version?: number | null }): { version?: number } {
  return typeof flag.version === "number" ? { version: flag.version } : {};
}

/** Organizations the key can see, for the organization picker. */
export async function listOrganizations(ctx: PostHogContext) {
  return ctx.api.getAll("/api/organizations/", "results");
}

export class PostHogClient implements PluginClient {
  private readonly ctx: PostHogContext;
  private readonly orgSetting: string;
  private orgIdPromise: Promise<string> | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("PostHog plugin: missing apiKey credential");
    const { baseUrl, region } = resolveHost(
      credentials["region"] ?? "us",
      credentials["host"] ?? "",
    );
    const caCert = credentials["caCert"] ?? "";
    this.ctx = createPostHogContext({
      baseUrl,
      region,
      apiKey,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    });
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
        const org = await this.ctx.api.get(`/api/organizations/${unencodedSegment("@current")}/`);
        return str(org.id);
      })();
      this.orgIdPromise.catch(() => {
        this.orgIdPromise = undefined;
      });
    }
    return this.orgIdPromise;
  }

  private async projects() {
    const org = pathEncode(await this.orgId());
    return this.ctx.api.getAll(`/api/organizations/${org}/projects/`, "results");
  }

  private objectType(typeId: string): ProjectObjectType {
    if (!isProjectObjectType(typeId)) {
      throw new Error(`PostHog plugin: unknown resource type "${typeId}"`);
    }
    return typeId;
  }

  private getObject<T extends ProjectObjectType>(
    typeId: T,
    projectId: string,
    id: string,
  ): Promise<ProjectObjects[T]> {
    return id
      ? OBJECTS[typeId].get(this.ctx.api, pathEncode(projectId), pathEncode(id))
      : listRouteRequest(this.ctx, "GET", OBJECTS[typeId].route, projectId);
  }

  private async listObjects<T extends ProjectObjectType>(
    typeId: T,
    accountId: string,
  ): Promise<ResourceInstance[]> {
    const projects = await this.projects();
    const lists = await Promise.all(
      projects.map(async (p) => {
        const pid = str(p.id);
        try {
          const items = await OBJECTS[typeId].list(this.ctx.api, pathEncode(pid));
          return items
            .filter((o) => o.deleted !== true)
            .map((o) => mapProjectObject(accountId, typeId, pid, o, this.ctx));
        } catch (err) {
          // A key scoped without this object's read scope, or to other projects.
          if (statusOf(err) === 403 || statusOf(err) === 404) return [];
          throw err;
        }
      }),
    );
    return lists.flat();
  }

  private async patch<T extends SoftDeletedType>(
    typeId: T,
    projectId: string,
    id: string,
    body: ObjectPatches[T],
  ): Promise<void> {
    if (!id) {
      await listRouteRequest(this.ctx, "PATCH", OBJECTS[typeId].route, projectId, { body });
      return;
    }
    await PATCHES[typeId](this.ctx.api, pathEncode(projectId), pathEncode(id), body);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  private async organization(accountId: string): Promise<ResourceInstance> {
    const id = await this.orgId();
    const [org, billing] = await Promise.all([
      this.ctx.api.get(`/api/organizations/${pathEncode(id)}/`),
      this.ctx.region === "self-hosted"
        ? Promise.resolve(undefined)
        : this.ctx.api.get("/api/billing/").catch(() => undefined),
    ]);
    const num = (v: string | null | undefined) =>
      v === null || v === undefined || v === "" ? undefined : Number(v);
    const period = billing?.billing_period;
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

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "organization":
          return [await this.organization(accountId)];
        case "project":
          return (await this.projects()).map((p) => mapProject(accountId, p, this.ctx));
        case "member": {
          const org = pathEncode(await this.orgId());
          try {
            return (await this.ctx.api.getAll(`/api/organizations/${org}/members/`, "results")).map(
              (m) => mapMember(accountId, m),
            );
          } catch (err) {
            if (statusOf(err) === 403) return [];
            throw err;
          }
        }
        default:
          return this.listObjects(this.objectType(typeId), accountId);
      }
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId) || resourceId;
      switch (typeId) {
        case "organization":
          return this.organization(accountId);
        case "project": {
          const org = await this.orgId();
          const p = await this.ctx.api.get(
            `/api/organizations/${pathEncode(org)}/projects/${pathEncode(ext)}/`,
          );
          return mapProject(accountId, p, this.ctx);
        }
        case "member": {
          const found = (await runPluginEffect(this.listResources("member", accountId))).find(
            (m) => m.externalId === ext,
          );
          if (!found) throw new Error(`PostHog plugin: member ${ext} not found`);
          return found;
        }
        default: {
          const [pid, id] = splitScoped(ext);
          const type = this.objectType(typeId);
          return mapProjectObject(
            accountId,
            type,
            pid,
            await this.getObject(type, pid, id),
            this.ctx,
          );
        }
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const v = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
      if (v === undefined)
        throw new Error(`PostHog plugin: cannot resolve "${outputKey}" for "${typeId}"`);
      return String(v);
    });
  }

  // -------------------------------------------------------------------------
  // Metrics, cost, query, preflight
  // -------------------------------------------------------------------------

  fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId) || resourceId;
      if (typeId === "organization") {
        return spendSeries(this.ctx, rangeOrDefault(timeRange, 30 * 24 * 3600_000));
      }
      const range = rangeOrDefault(timeRange);
      if (typeId === "project") return eventSeries(this.ctx, ext, range, "Events");
      if (typeId === "feature-flag") {
        const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const names = new Map<string, string>();
      const projects = await this.projects().catch((err) => {
        rethrowIncompleteList(err);
        return [];
      });
      for (const p of projects) names.set(str(p.id), str(p.name) || str(p.id));
      return fetchPostHogCost(this.ctx, range, names);
    });
  }

  executeQuery(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): PluginEffect<{ rows: Record<string, unknown>[]; durationMs: number }> {
    return attempt(async () => {
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
    });
  }

  introspectResource(): PluginEffect<SqlTableMeta[]> {
    return attempt(async () => {
      return ["events", "persons", "sessions", "groups", "person_distinct_ids"].map((name) => ({
        name,
        columns: [],
      }));
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyPostHogCredentials(
        this.ctx,
        () => this.orgId(),
        () => this.projects(),
      );
    });
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

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
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
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const pid = parentResourceId ? externalIdOf(parentResourceId) : str(fields["projectId"]);
      if (!pid) throw new Error("Pick a project.");
      const project = pathEncode(pid);
      switch (typeId) {
        case "feature-flag": {
          const key = (fields["key"] ?? "").trim();
          if (!/^[A-Za-z0-9_-]+$/.test(key))
            throw new Error("The key may only use letters, numbers, hyphens and underscores.");
          const created = await this.ctx.api.post(`/api/projects/${project}/feature_flags/`, {
            body: {
              key,
              name: fields["name"] ?? "",
              active: fields["active"] !== "false",
              filters: withRollout({ groups: [] }, Number(fields["rolloutPercentage"] || 0)),
              tags: csv(fields["tags"]),
            },
          });
          return mapProjectObject(accountId, typeId, pid, created, this.ctx);
        }
        case "dashboard": {
          const created = await this.ctx.api.post(`/api/projects/${project}/dashboards/`, {
            body: {
              name: (fields["name"] ?? "").trim(),
              description: fields["description"] ?? "",
            },
          });
          return mapProjectObject(accountId, typeId, pid, created, this.ctx);
        }
        case "annotation": {
          const created = await this.ctx.api.post(`/api/projects/${project}/annotations/`, {
            body: {
              content: (fields["content"] ?? "").trim(),
              date_marker: new Date(fields["dateMarker"] ?? "").toISOString(),
              scope: fields["scope"] || "project",
            },
          });
          return mapProjectObject(accountId, typeId, pid, created, this.ctx);
        }
        default:
          throw new Error(`PostHog plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Update / delete / actions
  // -------------------------------------------------------------------------

  /** Nothing to change sends nothing. */
  private async patchIfAny<T extends SoftDeletedType>(
    typeId: T,
    projectId: string,
    id: string,
    body: ObjectPatches[T],
  ): Promise<void> {
    if (Object.keys(body).length > 0) await this.patch(typeId, projectId, id, body);
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId) || resourceId;
      if (typeId === "member") {
        const level = LEVEL_IDS[fields["level"] ?? ""];
        if (level !== undefined) {
          const org = await this.orgId();
          await this.ctx.api.patch(
            `/api/organizations/${pathEncode(org)}/members/${pathEncode(ext)}/`,
            { body: { level } },
          );
        }
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }
      const [pid, id] = splitScoped(ext);
      const has = (k: string) => k in fields;
      switch (typeId) {
        case "feature-flag": {
          const body: ObjectPatches["feature-flag"] = {};
          if (has("name")) body.name = fields["name"] ?? "";
          if (has("active")) body.active = fields["active"] === "true";
          if (has("tags")) body.tags = csv(fields["tags"]);
          let rollout: number | undefined;
          if (has("rolloutPercentage") && fields["rolloutPercentage"] !== "") {
            rollout = Number(fields["rolloutPercentage"]);
            if (!Number.isFinite(rollout) || rollout < 0 || rollout > 100)
              throw new Error("Rollout must be between 0 and 100.");
          }
          if (rollout === undefined && Object.keys(body).length === 0) break;
          const current = await this.getObject(typeId, pid, id);
          if (rollout !== undefined) body.filters = withRollout(current.filters ?? {}, rollout);
          await this.patch(typeId, pid, id, { ...body, ...versionOf(current) });
          break;
        }
        case "dashboard": {
          const body: ObjectPatches["dashboard"] = {};
          if (fields["name"]?.trim()) body.name = fields["name"].trim();
          if (has("description")) body.description = fields["description"] ?? "";
          if (has("pinned")) body.pinned = fields["pinned"] === "true";
          if (has("tags")) body.tags = csv(fields["tags"]);
          await this.patchIfAny(typeId, pid, id, body);
          break;
        }
        case "experiment":
        case "cohort":
        case "insight":
        case "action": {
          const body: ObjectPatches["experiment"] &
            ObjectPatches["cohort"] &
            ObjectPatches["insight"] &
            ObjectPatches["action"] = {};
          if (fields["name"]?.trim()) body.name = fields["name"].trim();
          if (has("description")) body.description = fields["description"] ?? "";
          await this.patchIfAny(typeId, pid, id, body);
          break;
        }
        case "annotation": {
          const body: ObjectPatches["annotation"] = {};
          if (fields["content"]?.trim()) body.content = fields["content"].trim();
          await this.patchIfAny(typeId, pid, id, body);
          break;
        }
        default:
          throw new Error(`PostHog plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId) || resourceId;
      if (typeId === "member") {
        const org = await this.orgId();
        await this.ctx.api.delete(
          `/api/organizations/${pathEncode(org)}/members/${pathEncode(ext)}/`,
        );
        return;
      }
      if (typeId === "organization" || typeId === "project") {
        throw new Error(`PostHog plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
      const [pid, id] = splitScoped(ext);
      // Batch exports are the one type with a real DELETE; everything else is a
      // soft delete ("Hard delete of this model is not allowed").
      const type = this.objectType(typeId);
      if (type === "batch-export") {
        await (id
          ? this.ctx.api.delete(`/api/projects/${pathEncode(pid)}/batch_exports/${pathEncode(id)}/`)
          : listRouteRequest(this.ctx, "DELETE", OBJECTS[type].route, pid));
        return;
      }
      await this.patch(type, pid, id, {
        deleted: true,
        ...(type === "feature-flag" ? versionOf(await this.getObject(type, pid, id)) : {}),
      });
    });
  }

  /**
   * PostHog refuses this with no `version`, and from a multivariate flag with no
   * variant or from any other flag with one. Asking first says why in plain words.
   */
  private async rollOutToEveryone(projectId: string, id: string, variant: string): Promise<void> {
    const current = await this.getObject("feature-flag", projectId, id);
    const variants = variantKeys(current.filters);
    if (variants.length > 0 && !variant) {
      throw new Error(
        `This flag has variants. Pick the variant to give everyone: ${variants.join(", ")}.`,
      );
    }
    if (variant && !variants.includes(variant)) {
      throw new Error(`This flag has no variant "${variant}". Refresh it and try again.`);
    }
    await this.ctx.api.post(
      `/api/projects/${pathEncode(projectId)}/feature_flags/${pathEncode(id)}/roll_out_to_everyone/`,
      { body: { version: current.version ?? null, ...(variant ? { variant_key: variant } : {}) } },
    );
  }

  invokeAction(typeId: string, resourceId: string, actionId: string): PluginEffect<void> {
    return attempt(async () => {
      const [pid, id] = splitScoped(externalIdOf(resourceId) || resourceId);
      const project = pathEncode(pid);
      const target = pathEncode(id);
      const body = {};
      // Each of these is a POST of an empty object to `<object>/<action>/`.
      const post = async (
        route: string,
        action: string,
        typed: () => Promise<object | undefined>,
      ): Promise<void> => {
        await (id ? typed() : listRouteRequest(this.ctx, "POST", route, pid, { action, body }));
      };
      const { api } = this.ctx;
      if (typeId === "feature-flag") {
        const [action, ...variant] = actionId.split(":");
        if (action === ROLLOUT_ACTION) {
          await this.rollOutToEveryone(pid, id, variant.join(":"));
          return;
        }
      }
      switch (`${typeId}:${actionId}`) {
        case "feature-flag:enable":
          await post("feature_flags", "enable", async () =>
            api.post(`/api/projects/${project}/feature_flags/${target}/enable/`, {
              body: versionOf(await this.getObject("feature-flag", pid, id)),
            }),
          );
          return;
        case "feature-flag:disable":
          await post("feature_flags", "disable", async () =>
            api.post(`/api/projects/${project}/feature_flags/${target}/disable/`, {
              body: versionOf(await this.getObject("feature-flag", pid, id)),
            }),
          );
          return;
        case "experiment:launch":
          await post("experiments", "launch", () =>
            api.post(`/api/projects/${project}/experiments/${target}/launch/`, { body }),
          );
          return;
        case "experiment:pause":
          await post("experiments", "pause", () =>
            api.post(`/api/projects/${project}/experiments/${target}/pause/`, { body }),
          );
          return;
        case "experiment:resume":
          await post("experiments", "resume", () =>
            api.post(`/api/projects/${project}/experiments/${target}/resume/`, { body }),
          );
          return;
        case "experiment:archive":
          await post("experiments", "archive", () =>
            api.post(`/api/projects/${project}/experiments/${target}/archive/`, { body }),
          );
          return;
        case "experiment:end":
          await post("experiments", "end", () =>
            api.post(`/api/projects/${project}/experiments/${target}/end/`, { body }),
          );
          return;
        case "batch-export:pause":
          await post("batch_exports", "pause", () =>
            api.post(`/api/projects/${project}/batch_exports/${target}/pause/`, { body }),
          );
          return;
        case "batch-export:unpause":
          await post("batch_exports", "unpause", () =>
            api.post(`/api/projects/${project}/batch_exports/${target}/unpause/`, { body }),
          );
          return;
        case "hog-function:enable":
        case "hog-function:disable":
          await this.patch("hog-function", pid, id, { enabled: actionId === "enable" });
          return;
        default:
          throw new Error(`PostHog plugin: unknown action "${actionId}" for "${typeId}"`);
      }
    });
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
