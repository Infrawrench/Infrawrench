import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  KvListResult,
  LogsFetchParams,
  LogsFetchResult,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  decodePromptArgs,
  externalIdOf,
  ListPageError,
  ListTruncatedError,
  reportUnreadListPart,
} from "@infrawrench/plugin-base";
import type { DopplerContext } from "./api.js";
import {
  DopplerApiError,
  dopplerFetch,
  dopplerList,
  dopplerPaged,
  statusOf,
  tokenKind,
} from "./api.js";
import type {
  DopplerApiToken,
  DopplerConfig,
  DopplerEnvironment,
  DopplerGroup,
  DopplerIntegration,
  DopplerLog,
  DopplerProject,
  DopplerSecretValue,
  DopplerServiceAccount,
  DopplerServiceToken,
  DopplerWebhook,
  DopplerWorkplace,
  DopplerWorkplaceUser,
} from "./mappers.js";
import {
  joinId,
  mapApiToken,
  mapConfig,
  mapEnvironment,
  mapGroup,
  mapIntegration,
  mapProject,
  mapSecret,
  mapServiceAccount,
  mapServiceToken,
  mapSync,
  mapUser,
  mapWebhook,
  mapWorkplace,
  parent,
  projectKey,
  splitId,
} from "./mappers.js";
import { COMMANDS, ROLES_KEY, renderDopplerDetail, renderDopplerSidebar } from "./render.js";

/**
 * Configs one poll reads a type's children for, at a request each. Doppler allows 120 secret
 * reads and 240 other reads a minute on its Developer plan, and types are read at the same time.
 */
const MAX_CONFIG_READS = 100;
/** The most rows one poll can read and write. */
const MAX_SECRETS = 100_000;
/** The document does not say how long a page is. 10,000 rows at the 20 its other lists default to. */
const MAX_USER_PAGES = 500;

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function pickList(raw: string | undefined): string[] {
  const value = (raw ?? "").trim();
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return list(value);
}

const bool = (raw: string | undefined): boolean => /^(true|yes|1|on)$/i.test((raw ?? "").trim());

const EXPIRY_OPTIONS = [
  { id: "", label: "Never" },
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
  { id: "365", label: "1 year" },
];

/**
 * One list per parent. A parent the credential is refused, or one past the budget, keeps
 * its stored children rather than reading as having none, and anything else fails the
 * whole type. Past `maxReads` it reads a run from a random start, so every parent gets
 * read over time. A host that keeps no track answers false, and there a refusal shows and
 * the parents past the budget are read too, up to `maxRows`.
 */
async function readPerParent<P, R>(
  parents: readonly P[],
  parentId: (item: P) => string,
  read: (item: P) => Promise<readonly R[]>,
  options: {
    isRefusal?: (status: number) => boolean;
    maxReads?: number;
    maxRows?: { count: number; path: string };
  } = {},
): Promise<R[]> {
  const { isRefusal = (status) => status === 403, maxReads = Infinity } = options;
  const maxRows = options.maxRows?.count ?? Infinity;
  const start = parents.length > maxReads ? Math.floor(Math.random() * parents.length) : 0;
  const out: R[] = [];
  const unread: string[] = [];
  const skipped: P[] = [];
  let reads = 0;
  let refusal: unknown;
  for (const item of [...parents.slice(start), ...parents.slice(0, start)]) {
    if (reads >= maxReads || out.length >= maxRows) {
      unread.push(parentId(item));
      skipped.push(item);
      continue;
    }
    reads++;
    try {
      for (const row of await read(item)) out.push(row);
    } catch (err) {
      if (!isRefusal(statusOf(err))) throw err;
      unread.push(parentId(item));
      refusal ??= err;
    }
  }
  if (unread.length === 0 || reportUnreadListPart({ parentResourceIds: unread })) return out;
  if (refusal !== undefined) throw refusal;
  for (const item of skipped) {
    if (out.length >= maxRows) {
      throw new ListTruncatedError({
        vendor: "Doppler",
        path: options.maxRows?.path ?? "",
        items: out.length,
        maxItems: maxRows,
      });
    }
    for (const row of await read(item)) out.push(row);
  }
  return out;
}

function logText(logs: DopplerLog[]): string {
  return logs
    .slice()
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .map((l) => {
      const who = l.user?.email ?? l.user?.name ?? "system";
      const where = [l.project, l.config ?? l.environment].filter(Boolean).join("/");
      return `${l.created_at ?? ""}  ${who}  ${where ? `[${where}] ` : ""}${l.text ?? ""}\n`;
    })
    .join("");
}

export class DopplerClient implements PluginClient {
  private readonly ctx: DopplerContext;
  private projectsCache: Promise<DopplerProject[]> | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const token = (credentials["token"] ?? "").trim();
    if (!token) throw new Error("Doppler plugin: missing the API token");
    if (tokenKind(token) === "service") {
      throw new Error(
        "Doppler plugin: this is a service token (dp.st.), which only reads one config. Use a personal token (dp.pt.) or a service account token (dp.sa.).",
      );
    }
    this.ctx = { token, ...(services?.http ? { http: services.http } : {}) };
  }

  private projects(): Promise<DopplerProject[]> {
    this.projectsCache ??= dopplerPaged<DopplerProject>(this.ctx, "/v3/projects", "projects").catch(
      (err: unknown) => {
        this.projectsCache = undefined;
        throw err;
      },
    );
    return this.projectsCache;
  }

  private configs(project: string): Promise<DopplerConfig[]> {
    return dopplerPaged<DopplerConfig>(this.ctx, "/v3/configs", "configs", { project });
  }

  private environments(project: string): Promise<DopplerEnvironment[]> {
    return dopplerList<DopplerEnvironment>(this.ctx, "/v3/environments", "environments", {
      project,
    });
  }

  private async secrets(
    project: string,
    config: string,
  ): Promise<Record<string, DopplerSecretValue>> {
    const path = "/v3/configs/config/secrets";
    const page = await dopplerFetch<
      { secrets?: Record<string, DopplerSecretValue> | null } | undefined
    >(this.ctx, path, { query: { project, config } });
    const secrets = page?.secrets;
    if (secrets === null) return {};
    if (typeof secrets !== "object" || Array.isArray(secrets))
      throw new ListPageError({ vendor: "Doppler", path, key: "secrets", found: secrets, page });
    return secrets;
  }

  private async users(): Promise<DopplerWorkplaceUser[]> {
    return dopplerPaged<DopplerWorkplaceUser>(
      this.ctx,
      "/v3/workplace/users",
      "workplace_users",
      {},
      MAX_USER_PAGES,
      0,
    );
  }

  /** Every config of every project, for a form's picker. */
  private async allConfigs(): Promise<Array<{ project: string; config: DopplerConfig }>> {
    const out: Array<{ project: string; config: DopplerConfig }> = [];
    for (const p of await this.projects()) {
      const key = projectKey(p);
      for (const c of await this.configs(key)) out.push({ project: key, config: c });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /** Every config a list can read, with a refused project keeping what hangs off it. */
  private async listedConfigs(
    accountId: string,
  ): Promise<Array<{ project: string; config: DopplerConfig }>> {
    return readPerParent(
      await this.projects(),
      (p) => parent(accountId, "doppler-project", projectKey(p)),
      async (p) => {
        const project = projectKey(p);
        return (await this.configs(project)).map((config) => ({ project, config }));
      },
    );
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      try {
        return await this.readResources(typeId, accountId);
      } catch (err) {
        if (statusOf(err) !== 403) throw err;
        // A service account's role can refuse a whole type. This type's stored rows stay. A
        // host that keeps no track (the desktop) answers false, and there the refusal shows.
        if (!reportUnreadListPart({ idPrefixes: [""] })) throw err;
        return [];
      }
    });
  }

  private async readResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "doppler-workplace": {
        const path = "/v3/workplace";
        const page = await dopplerFetch<{ workplace?: DopplerWorkplace } | undefined>(
          this.ctx,
          path,
        );
        if (!page?.workplace)
          throw new ListPageError({
            vendor: "Doppler",
            path,
            key: "workplace",
            found: page?.workplace,
            page,
          });
        return [mapWorkplace(accountId, page.workplace)];
      }
      case "doppler-project": {
        this.projectsCache = undefined;
        return (await this.projects()).map((p) => mapProject(accountId, p));
      }
      case "doppler-environment":
        return readPerParent(
          await this.projects(),
          (p) => parent(accountId, "doppler-project", projectKey(p)),
          async (p) => {
            const key = projectKey(p);
            return (await this.environments(key)).map((e) => mapEnvironment(accountId, key, e));
          },
        );
      case "doppler-config":
        return (await this.listedConfigs(accountId)).map(({ project, config }) =>
          mapConfig(accountId, project, config),
        );
      case "doppler-secret":
        return readPerParent(
          await this.listedConfigs(accountId),
          ({ project, config }) =>
            parent(accountId, "doppler-config", joinId(project, config.name)),
          async ({ project, config }) => {
            // Values come back on the wire (Doppler has no metadata-only listing that includes
            // visibility); only names, visibility and notes are kept.
            const secrets = await this.secrets(project, config.name);
            return Object.entries(secrets).map(([name, v]) =>
              mapSecret(accountId, project, config.name, name, v),
            );
          },
          {
            maxReads: MAX_CONFIG_READS,
            maxRows: { count: MAX_SECRETS, path: "/v3/configs/config/secrets" },
          },
        );
      case "doppler-service-token":
        return readPerParent(
          await this.listedConfigs(accountId),
          ({ project, config }) =>
            parent(accountId, "doppler-config", joinId(project, config.name)),
          async ({ project, config }) =>
            (
              await dopplerList<DopplerServiceToken>(
                this.ctx,
                "/v3/configs/config/tokens",
                "tokens",
                { project, config: config.name },
              )
            ).map((t) => mapServiceToken(accountId, project, config.name, t)),
          { maxReads: MAX_CONFIG_READS },
        );
      case "doppler-integration":
        return (
          await dopplerList<DopplerIntegration>(this.ctx, "/v3/integrations", "integrations")
        ).map((i) => mapIntegration(accountId, i));
      case "doppler-sync":
        return (
          await dopplerList<DopplerIntegration>(this.ctx, "/v3/integrations", "integrations")
        ).flatMap((i) =>
          (i.syncs ?? []).map((s) =>
            mapSync(accountId, { ...s, integration: s.integration ?? i.slug }, i),
          ),
        );
      case "doppler-webhook":
        return readPerParent(
          await this.projects(),
          (p) => parent(accountId, "doppler-project", projectKey(p)),
          async (p) => {
            const key = projectKey(p);
            return (
              await dopplerList<DopplerWebhook>(this.ctx, "/v3/webhooks", "webhooks", {
                project: key,
              })
            ).map((w) => mapWebhook(accountId, key, w));
          },
          // The document's only error for this route is a 400 it does not describe.
          { isRefusal: (status) => status === 403 || status === 400 },
        );
      case "doppler-user":
        return (await this.users()).map((u) => mapUser(accountId, u));
      case "doppler-group": {
        const groups = await dopplerPaged<DopplerGroup>(this.ctx, "/v3/workplace/groups", "groups");
        const emails = await this.userEmails().catch((err: unknown) => {
          if (statusOf(err) === 403) return new Map<string, string>();
          throw err;
        });
        const out: ResourceInstance[] = [];
        for (const g of groups) {
          const full = await dopplerFetch<{ group?: DopplerGroup }>(
            this.ctx,
            `/v3/workplace/groups/group/${encodeURIComponent(g.slug)}`,
          )
            .then((r) => r?.group ?? g)
            .catch((err: unknown) => {
              if (statusOf(err) === 403 || statusOf(err) === 404) return g;
              throw err;
            });
          out.push(mapGroup(accountId, full, emails));
        }
        return out;
      }
      case "doppler-service-account":
        return (
          await dopplerPaged<DopplerServiceAccount>(
            this.ctx,
            "/v3/workplace/service_accounts",
            "service_accounts",
          )
        ).map((s) => mapServiceAccount(accountId, s));
      case "doppler-service-account-token":
        return readPerParent(
          await dopplerPaged<DopplerServiceAccount>(
            this.ctx,
            "/v3/workplace/service_accounts",
            "service_accounts",
          ),
          (sa) => parent(accountId, "doppler-service-account", sa.slug),
          async (sa) =>
            (
              await dopplerPaged<DopplerApiToken>(
                this.ctx,
                `/v3/workplace/service_accounts/service_account/${encodeURIComponent(sa.slug)}/tokens`,
                "api_tokens",
              )
            ).map((t) => mapApiToken(accountId, sa, t)),
        );
      default:
        throw new Error(`Doppler plugin: unknown resource type "${typeId}"`);
    }
  }

  private async userEmails(): Promise<Map<string, string>> {
    return new Map((await this.users()).map((u) => [u.id, u.user?.email ?? u.id]));
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const missing = () => new DopplerApiError(404, `Doppler plugin: ${typeId} "${id}" not found`);
      switch (typeId) {
        case "doppler-workplace": {
          const [w] = await this.readResources(typeId, accountId);
          if (!w) throw missing();
          return w;
        }
        case "doppler-project": {
          const r = await dopplerFetch<{ project?: DopplerProject }>(
            this.ctx,
            "/v3/projects/project",
            { query: { project: id } },
          );
          if (!r?.project) throw missing();
          const [envs, configs] = await Promise.all([
            this.environments(id).catch(() => undefined),
            this.configs(id).catch(() => undefined),
          ]);
          return mapProject(
            accountId,
            { ...r.project, slug: r.project.slug ?? id },
            {
              ...(envs ? { environments: envs.length } : {}),
              ...(configs ? { configs: configs.length } : {}),
            },
          );
        }
        case "doppler-environment": {
          const [project, env] = splitId(id, 2) as [string, string];
          const e = (await this.environments(project)).find((x) => (x.slug || x.id) === env);
          if (!e) throw missing();
          return mapEnvironment(accountId, project, e);
        }
        case "doppler-config": {
          const [project, config] = splitId(id, 2) as [string, string];
          const r = await dopplerFetch<{ config?: DopplerConfig }>(this.ctx, "/v3/configs/config", {
            query: { project, config },
          });
          if (!r?.config) throw missing();
          const names = await dopplerFetch<{ names?: string[] }>(
            this.ctx,
            "/v3/configs/config/secrets/names",
            {
              query: { project, config },
            },
          ).catch(() => undefined);
          return mapConfig(accountId, project, r.config, names?.names?.length);
        }
        case "doppler-secret": {
          const [project, config, name] = splitId(id, 3) as [string, string, string];
          const r = await dopplerFetch<{ name?: string; value?: DopplerSecretValue }>(
            this.ctx,
            "/v3/configs/config/secret",
            {
              query: { project, config, name },
            },
          );
          return mapSecret(accountId, project, config, name, r?.value ?? {});
        }
        case "doppler-service-token": {
          const [project, config, slug] = splitId(id, 3) as [string, string, string];
          const r = await dopplerFetch<{ tokens?: DopplerServiceToken[] }>(
            this.ctx,
            "/v3/configs/config/tokens",
            { query: { project, config } },
          );
          const t = r?.tokens?.find((x) => x.slug === slug);
          if (!t) throw missing();
          return mapServiceToken(accountId, project, config, t);
        }
        case "doppler-integration": {
          const r = await dopplerFetch<{ integration?: DopplerIntegration }>(
            this.ctx,
            "/v3/integrations/integration",
            {
              query: { integration: id },
            },
          );
          if (!r?.integration) throw missing();
          return mapIntegration(accountId, r.integration);
        }
        case "doppler-sync": {
          const [project, config, slug] = splitId(id, 3) as [string, string, string];
          const r = await dopplerFetch<{
            sync?: {
              slug: string;
              integration?: string;
              project?: string;
              config?: string;
              enabled?: boolean;
              lastSyncedAt?: string;
            };
          }>(this.ctx, "/v3/configs/config/syncs/sync", { query: { project, config, sync: slug } });
          if (!r?.sync) throw missing();
          return mapSync(accountId, r.sync);
        }
        case "doppler-webhook": {
          const [project, slug] = splitId(id, 2) as [string, string];
          const r = await dopplerFetch<{ webhook?: DopplerWebhook }>(
            this.ctx,
            `/v3/webhooks/webhook/${encodeURIComponent(slug)}`,
            {
              query: { project },
            },
          );
          if (!r?.webhook) throw missing();
          return mapWebhook(accountId, project, r.webhook);
        }
        case "doppler-user": {
          const r = await dopplerFetch<{ workplace_user?: DopplerWorkplaceUser }>(
            this.ctx,
            `/v3/workplace/users/${encodeURIComponent(id)}`,
          );
          if (!r?.workplace_user) throw missing();
          const u = mapUser(accountId, r.workplace_user);
          const roles = await dopplerFetch<{
            roles?: Array<{ identifier?: string; name?: string }>;
          }>(this.ctx, "/v3/workplace/roles").catch(() => undefined);
          return roles?.roles?.length
            ? {
                ...u,
                resolvedOutputs: { ...u.resolvedOutputs, [ROLES_KEY]: JSON.stringify(roles.roles) },
              }
            : u;
        }
        case "doppler-group": {
          const r = await dopplerFetch<{ group?: DopplerGroup }>(
            this.ctx,
            `/v3/workplace/groups/group/${encodeURIComponent(id)}`,
          );
          if (!r?.group) throw missing();
          return mapGroup(
            accountId,
            r.group,
            await this.userEmails().catch(() => new Map<string, string>()),
          );
        }
        case "doppler-service-account": {
          const r = await dopplerFetch<{ service_account?: DopplerServiceAccount }>(
            this.ctx,
            `/v3/workplace/service_accounts/service_account/${encodeURIComponent(id)}`,
          );
          if (!r?.service_account) throw missing();
          return mapServiceAccount(accountId, r.service_account);
        }
        case "doppler-service-account-token": {
          const all = await this.readResources(typeId, accountId);
          const hit = all.find((t) => t.externalId === id);
          if (!hit) throw missing();
          return hit;
        }
        default:
          throw new Error(`Doppler plugin: unknown resource type "${typeId}"`);
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
      const id = externalIdOf(resourceId);
      if (typeId === "doppler-secret" && outputKey === "value") {
        const [project, config, name] = splitId(id, 3) as [string, string, string];
        const r = await dopplerFetch<{ value?: DopplerSecretValue }>(
          this.ctx,
          "/v3/configs/config/secret",
          { query: { project, config, name } },
        );
        const v = r?.value?.computed ?? r?.value?.raw;
        if (v === undefined || v === null)
          throw new Error(
            "Doppler plugin: this secret's value is restricted and can't be read back",
          );
        return v;
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      throw new Error(`Doppler plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Secrets editor (Keys tab on a config) and logs
  // -------------------------------------------------------------------------

  listKvKeys(
    _typeId: string,
    resourceId: string,
    _accountId: string,
    params?: { prefix?: string },
  ): PluginEffect<KvListResult> {
    return attempt(async () => {
      const [project, config] = splitId(externalIdOf(resourceId), 2) as [string, string];
      const r = await dopplerFetch<{ names?: string[] }>(
        this.ctx,
        "/v3/configs/config/secrets/names",
        { query: { project, config } },
      );
      const prefix = params?.prefix ?? "";
      return {
        items: (r?.names ?? [])
          .filter((n) => n.startsWith(prefix))
          .sort()
          .map((name) => ({ name })),
      };
    });
  }

  getKvValue(
    _typeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const [project, config] = splitId(externalIdOf(resourceId), 2) as [string, string];
      const r = await dopplerFetch<{ value?: DopplerSecretValue }>(
        this.ctx,
        "/v3/configs/config/secret",
        { query: { project, config, name: key } },
      );
      const raw = r?.value?.raw;
      if (raw === undefined || raw === null)
        throw new Error(
          "Doppler plugin: this secret is restricted and its value can't be read back",
        );
      return raw;
    });
  }

  putKvValue(
    _typeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
    value: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const [project, config] = splitId(externalIdOf(resourceId), 2) as [string, string];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(
          "Doppler plugin: secret names may only contain letters, digits and underscores, and can't start with a digit",
        );
      }
      await dopplerFetch(this.ctx, "/v3/configs/config/secrets", {
        method: "POST",
        body: { project, config, secrets: { [key]: value } },
      });
    });
  }

  deleteKvKey(
    _typeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const [project, config] = splitId(externalIdOf(resourceId), 2) as [string, string];
      await dopplerFetch(this.ctx, "/v3/configs/config/secret", {
        method: "DELETE",
        query: { project, config, name: key },
      });
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      const perPage = Math.min(Math.max(params.tailLines ?? 100, 1), 100);
      if (typeId === "doppler-workplace") {
        const r = await dopplerFetch<{ logs?: DopplerLog[] }>(this.ctx, "/v3/logs", {
          query: { page: 1, per_page: perPage },
        });
        return {
          text: logText(r?.logs ?? []),
          containers: ["activity"],
          activeContainer: "activity",
        };
      }
      if (typeId === "doppler-config") {
        const [project, config] = splitId(externalIdOf(resourceId), 2) as [string, string];
        const r = await dopplerFetch<{ logs?: DopplerLog[] }>(this.ctx, "/v3/configs/config/logs", {
          query: { project, config, page: 1, per_page: perPage },
        });
        return {
          text: logText(r?.logs ?? []),
          containers: ["changes"],
          activeContainer: "changes",
        };
      }
      return { text: "", containers: [], activeContainer: "" };
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      const parentId = parentResourceId ? externalIdOf(parentResourceId) : undefined;
      const projectPicker = async () => {
        if (parentId && parentResourceId?.includes(":doppler-project:")) return [];
        const projects = await this.projects().catch(() => [] as DopplerProject[]);
        return [
          {
            key: "project",
            label: "Project",
            kind: "select" as const,
            required: true,
            ...(projects[0] ? { defaultValue: projectKey(projects[0]) } : {}),
            options: projects.map((p) => ({ id: projectKey(p), label: p.name })),
          },
        ];
      };
      const configPicker = async () => {
        if (parentId && parentResourceId?.includes(":doppler-config:")) return [];
        const all = await this.allConfigs().catch(() => []);
        return [
          {
            key: "projectConfig",
            label: "Config",
            kind: "select" as const,
            required: true,
            ...(all[0] ? { defaultValue: joinId(all[0].project, all[0].config.name) } : {}),
            options: all.map(({ project, config }) => ({
              id: joinId(project, config.name),
              label: `${project} / ${config.name}`,
            })),
          },
        ];
      };
      switch (typeId) {
        case "doppler-project":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true, placeholder: "backend" },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case "doppler-environment":
          return {
            fields: [
              ...(await projectPicker()),
              { key: "name", label: "Name", kind: "text", required: true, placeholder: "QA" },
              {
                key: "slug",
                label: "Slug",
                kind: "text",
                required: true,
                placeholder: "qa",
                description: "Also the name of its root config.",
              },
            ],
          };
        case "doppler-config": {
          const project = parentId ?? "";
          const envs = project
            ? await this.environments(project).catch(() => [] as DopplerEnvironment[])
            : [];
          return {
            fields: [
              ...(await projectPicker()),
              {
                key: "environment",
                label: "Environment",
                kind: envs.length ? "select" : "text",
                required: true,
                ...(envs[0] ? { defaultValue: envs[0].slug || envs[0].id } : {}),
                ...(envs.length
                  ? { options: envs.map((e) => ({ id: e.slug || e.id, label: e.name ?? e.id })) }
                  : { placeholder: "dev" }),
              },
              {
                key: "name",
                label: "Branch name",
                kind: "text",
                required: true,
                placeholder: "dev_feature",
                description:
                  "Must start with the environment slug and an underscore, e.g. dev_feature.",
              },
            ],
          };
        }
        case "doppler-secret":
          return {
            fields: [
              ...(await configPicker()),
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "DATABASE_URL",
              },
              { key: "value", label: "Value", kind: "password", required: true },
              {
                key: "visibility",
                label: "Visibility",
                kind: "select",
                required: false,
                defaultValue: "masked",
                options: [
                  { id: "masked", label: "Masked" },
                  { id: "unmasked", label: "Unmasked" },
                  {
                    id: "restricted",
                    label: "Restricted",
                    description: "Can't be read back in the dashboard or API",
                  },
                ],
              },
            ],
          };
        case "doppler-service-token":
          return {
            fields: [
              ...(await configPicker()),
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "production-api",
              },
              {
                key: "access",
                label: "Access",
                kind: "select",
                required: true,
                defaultValue: "read",
                options: [
                  { id: "read", label: "Read" },
                  { id: "read/write", label: "Read & write" },
                ],
              },
              {
                key: "expiresInDays",
                label: "Expires after",
                kind: "select",
                required: false,
                defaultValue: "",
                options: EXPIRY_OPTIONS,
              },
            ],
          };
        case "doppler-webhook": {
          const project = parentId ?? "";
          const configs = project
            ? await this.configs(project).catch(() => [] as DopplerConfig[])
            : [];
          return {
            fields: [
              ...(await projectPicker()),
              {
                key: "url",
                label: "URL",
                kind: "text",
                required: true,
                placeholder: "https://example.com/hooks/doppler",
              },
              { key: "name", label: "Name", kind: "text", required: false },
              {
                key: "configs",
                label: "Configs",
                kind: configs.length ? "policy-picker" : "string-list",
                required: false,
                description: "Fire when secrets change in these configs.",
                ...(configs.length
                  ? {
                      policies: configs.map((c) => ({
                        id: c.name,
                        label: c.name,
                        category: c.environment ?? "",
                      })),
                    }
                  : {}),
              },
              { key: "secret", label: "Signing secret", kind: "password", required: false },
            ],
          };
        }
        case "doppler-group":
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "engineering",
              },
              {
                key: "defaultProjectRole",
                label: "Default project role",
                kind: "select",
                required: false,
                defaultValue: "",
                options: [
                  { id: "", label: "Workplace default" },
                  { id: "viewer", label: "Viewer" },
                  { id: "collaborator", label: "Collaborator" },
                  { id: "admin", label: "Admin" },
                  { id: "no_access", label: "No access" },
                ],
              },
            ],
          };
        default:
          throw new Error(`Doppler plugin: cannot create "${typeId}" from Infrawrench`);
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
      const text = (k: string) => (fields[k] ?? "").trim();
      const parentId = parentResourceId ? externalIdOf(parentResourceId) : "";
      const project = parentResourceId?.includes(":doppler-project:") ? parentId : text("project");
      const projectConfig = parentResourceId?.includes(":doppler-config:")
        ? parentId
        : text("projectConfig");
      const ref = (ext: string) => `${accountId}:${typeId}:${ext}`;
      switch (typeId) {
        case "doppler-project": {
          const r = await dopplerFetch<{ project?: DopplerProject }>(this.ctx, "/v3/projects", {
            method: "POST",
            body: { name: text("name"), description: text("description") },
          });
          this.projectsCache = undefined;
          return mapProject(accountId, r?.project ?? { id: text("name"), name: text("name") });
        }
        case "doppler-environment": {
          await dopplerFetch(this.ctx, "/v3/environments", {
            method: "POST",
            query: { project },
            body: { name: text("name"), slug: text("slug") },
          });
          return runPluginEffect(
            this.getResource(typeId, ref(joinId(project, text("slug"))), accountId),
          );
        }
        case "doppler-config": {
          await dopplerFetch(this.ctx, "/v3/configs", {
            method: "POST",
            body: { project, environment: text("environment"), name: text("name") },
          });
          return runPluginEffect(
            this.getResource(typeId, ref(joinId(project, text("name"))), accountId),
          );
        }
        case "doppler-secret": {
          const [p, c] = splitId(projectConfig, 2) as [string, string];
          const name = text("name");
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new Error(
              "Doppler plugin: secret names may only contain letters, digits and underscores",
            );
          await dopplerFetch(this.ctx, "/v3/configs/config/secrets", {
            method: "POST",
            body: {
              project: p,
              config: c,
              change_requests: [
                {
                  name,
                  originalName: null,
                  value: fields["value"] ?? "",
                  visibility: text("visibility") || "masked",
                },
              ],
            },
          });
          return runPluginEffect(this.getResource(typeId, ref(joinId(p, c, name)), accountId));
        }
        case "doppler-service-token": {
          const [p, c] = splitId(projectConfig, 2) as [string, string];
          const days = Number(text("expiresInDays"));
          const r = await dopplerFetch<{ token?: DopplerServiceToken }>(
            this.ctx,
            "/v3/configs/config/tokens",
            {
              method: "POST",
              body: {
                project: p,
                config: c,
                name: text("name"),
                access: text("access") || "read",
                ...(days > 0
                  ? { expire_at: new Date(Date.now() + days * 86_400_000).toISOString() }
                  : {}),
              },
            },
          );
          if (!r?.token) throw new DopplerApiError(500, "Doppler plugin: no token was returned");
          const t = mapServiceToken(accountId, p, c, r.token);
          return r.token.key
            ? {
                ...t,
                resolvedOutputs: { ...t.resolvedOutputs, token: r.token.key },
                secretStates: [
                  { fieldKey: "token", resolution: { kind: "plaintext", value: r.token.key } },
                ],
              }
            : t;
        }
        case "doppler-webhook": {
          const url = text("url");
          if (!/^https:\/\//i.test(url))
            throw new Error("Doppler plugin: webhook URLs must use https");
          await dopplerFetch(this.ctx, "/v3/webhooks", {
            method: "POST",
            query: { project },
            body: {
              url,
              ...(text("name") ? { name: text("name") } : {}),
              ...(fields["secret"] ? { secret: fields["secret"] } : {}),
              enableConfigs: pickList(fields["configs"]),
            },
          });
          const r = await dopplerFetch<{ webhooks?: DopplerWebhook[] }>(this.ctx, "/v3/webhooks", {
            query: { project },
          });
          const w = (r?.webhooks ?? []).find((x) => x.url === url);
          if (!w)
            throw new DopplerApiError(
              500,
              "Doppler plugin: the webhook was created but could not be read back",
            );
          return mapWebhook(accountId, project, w);
        }
        case "doppler-group": {
          const r = await dopplerFetch<{ group?: DopplerGroup }>(this.ctx, "/v3/workplace/groups", {
            method: "POST",
            body: {
              name: text("name"),
              ...(text("defaultProjectRole")
                ? { default_project_role: text("defaultProjectRole") }
                : {}),
            },
          });
          if (!r?.group) throw new DopplerApiError(500, "Doppler plugin: no group was returned");
          return mapGroup(accountId, r.group);
        }
        default:
          throw new Error(`Doppler plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const has = (k: string) => k in fields;
      const text = (k: string) => (fields[k] ?? "").trim();
      const ref = (ext: string) => `${accountId}:${typeId}:${ext}`;
      switch (typeId) {
        case "doppler-workplace": {
          const body: Record<string, string> = {};
          if (has("name") && text("name")) body["name"] = text("name");
          if (has("billingEmail")) body["billing_email"] = text("billingEmail");
          if (has("securityEmail")) body["security_email"] = text("securityEmail");
          await dopplerFetch(this.ctx, "/v3/workplace", { method: "POST", body });
          break;
        }
        case "doppler-project": {
          const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          await dopplerFetch(this.ctx, "/v3/projects/project", {
            method: "POST",
            body: {
              project: id,
              name:
                has("name") && text("name") ? text("name") : String(current.fields["name"] ?? id),
              description: has("description")
                ? text("description")
                : String(current.fields["description"] ?? ""),
            },
          });
          this.projectsCache = undefined;
          break;
        }
        case "doppler-environment": {
          const [project, env] = splitId(id, 2) as [string, string];
          const body: Record<string, string> = {};
          if (has("name") && text("name")) body["name"] = text("name");
          if (has("slug") && text("slug") && text("slug") !== env) body["slug"] = text("slug");
          if (Object.keys(body).length) {
            await dopplerFetch(this.ctx, "/v3/environments/environment", {
              method: "PUT",
              query: { project, environment: env },
              body,
            });
          }
          return runPluginEffect(
            this.getResource(typeId, ref(joinId(project, body["slug"] ?? env)), accountId),
          );
        }
        case "doppler-config": {
          let [project, config] = splitId(id, 2) as [string, string];
          if (has("name") && text("name") && text("name") !== config) {
            await dopplerFetch(this.ctx, "/v3/configs/config", {
              method: "POST",
              body: { project, config, name: text("name") },
            });
            config = text("name");
          }
          if (has("inheritable")) {
            await dopplerFetch(this.ctx, "/v3/configs/config/inheritable", {
              method: "POST",
              body: { project, config, inheritable: bool(fields["inheritable"]) },
            });
          }
          return runPluginEffect(this.getResource(typeId, ref(joinId(project, config)), accountId));
        }
        case "doppler-secret": {
          const [project, config, name] = splitId(id, 3) as [string, string, string];
          const change: Record<string, unknown> = { name, originalName: name, value: null };
          let changed = false;
          if (has("newValue") && fields["newValue"]) {
            change["value"] = fields["newValue"];
            changed = true;
          }
          if (has("visibility") && text("visibility")) {
            change["visibility"] = text("visibility");
            changed = true;
          }
          if (changed) {
            await dopplerFetch(this.ctx, "/v3/configs/config/secrets", {
              method: "POST",
              body: { project, config, change_requests: [change] },
            });
          }
          if (has("note")) {
            await dopplerFetch(this.ctx, "/v3/projects/project/note", {
              method: "POST",
              query: { project },
              body: { secret: name, note: text("note") },
            });
          }
          break;
        }
        case "doppler-webhook": {
          const [project, slug] = splitId(id, 2) as [string, string];
          const body: Record<string, unknown> = {};
          if (has("name")) body["name"] = text("name");
          if (has("url") && text("url")) {
            if (!/^https:\/\//i.test(text("url")))
              throw new Error("Doppler plugin: webhook URLs must use https");
            body["url"] = text("url");
          }
          if (has("enabledConfigs")) {
            const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
            const before = new Set(list(String(current.fields["enabledConfigs"] ?? "")));
            const after = new Set(list(fields["enabledConfigs"]));
            body["enableConfigs"] = [...after].filter((c) => !before.has(c));
            body["disableConfigs"] = [...before].filter((c) => !after.has(c));
          }
          await dopplerFetch(this.ctx, `/v3/webhooks/webhook/${encodeURIComponent(slug)}`, {
            method: "PATCH",
            query: { project },
            body,
          });
          break;
        }
        case "doppler-group": {
          const body: Record<string, string> = {};
          if (has("name") && text("name")) body["name"] = text("name");
          if (has("defaultProjectRole")) body["default_project_role"] = text("defaultProjectRole");
          if (Object.keys(body).length) {
            await dopplerFetch(this.ctx, `/v3/workplace/groups/group/${encodeURIComponent(id)}`, {
              method: "PATCH",
              body,
            });
          }
          if (has("members")) {
            const [group, users] = await Promise.all([
              dopplerFetch<{ group?: DopplerGroup }>(
                this.ctx,
                `/v3/workplace/groups/group/${encodeURIComponent(id)}`,
              ),
              this.users(),
            ]);
            const byEmail = new Map(users.map((u) => [(u.user?.email ?? "").toLowerCase(), u.id]));
            const current = new Set(
              (group?.group?.members ?? [])
                .filter((m) => m.type === "workplace_user" && m.slug)
                .map((m) => m.slug!),
            );
            const wanted = new Set<string>();
            for (const email of list(fields["members"])) {
              const slug =
                byEmail.get(email.toLowerCase()) ??
                (users.some((u) => u.id === email) ? email : undefined);
              if (!slug)
                throw new Error(`Doppler plugin: ${email} is not a member of the workplace`);
              wanted.add(slug);
            }
            for (const slug of wanted) {
              if (!current.has(slug)) {
                await dopplerFetch(
                  this.ctx,
                  `/v3/workplace/groups/group/${encodeURIComponent(id)}/members`,
                  {
                    method: "POST",
                    body: { type: "workplace_user", slug },
                  },
                );
              }
            }
            for (const slug of current) {
              if (!wanted.has(slug)) {
                await dopplerFetch(
                  this.ctx,
                  `/v3/workplace/groups/group/${encodeURIComponent(id)}/members/workplace_user/${encodeURIComponent(slug)}`,
                  {
                    method: "DELETE",
                  },
                );
              }
            }
          }
          break;
        }
        default:
          throw new Error(`Doppler plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "doppler-project":
          await dopplerFetch(this.ctx, "/v3/projects/project", {
            method: "DELETE",
            body: { project: id },
          });
          this.projectsCache = undefined;
          return;
        case "doppler-environment": {
          const [project, environment] = splitId(id, 2) as [string, string];
          await dopplerFetch(this.ctx, "/v3/environments/environment", {
            method: "DELETE",
            query: { project, environment },
          });
          return;
        }
        case "doppler-config": {
          const [project, config] = splitId(id, 2) as [string, string];
          await dopplerFetch(this.ctx, "/v3/configs/config", {
            method: "DELETE",
            query: { project, config },
          });
          return;
        }
        case "doppler-secret": {
          const [project, config, name] = splitId(id, 3) as [string, string, string];
          await dopplerFetch(this.ctx, "/v3/configs/config/secret", {
            method: "DELETE",
            query: { project, config, name },
          });
          return;
        }
        case "doppler-service-token": {
          const [project, config, slug] = splitId(id, 3) as [string, string, string];
          await dopplerFetch(this.ctx, "/v3/configs/config/tokens/token", {
            method: "DELETE",
            body: { project, config, slug },
          });
          return;
        }
        case "doppler-integration":
          await dopplerFetch(this.ctx, "/v3/integrations/integration", {
            method: "DELETE",
            query: { integration: id },
          });
          return;
        case "doppler-sync": {
          const [project, config, sync] = splitId(id, 3) as [string, string, string];
          await dopplerFetch(this.ctx, "/v3/configs/config/syncs/sync", {
            method: "DELETE",
            query: { project, config, sync, delete_from_target: false },
          });
          return;
        }
        case "doppler-webhook": {
          const [project, slug] = splitId(id, 2) as [string, string];
          await dopplerFetch(this.ctx, `/v3/webhooks/webhook/${encodeURIComponent(slug)}`, {
            method: "DELETE",
            query: { project },
          });
          return;
        }
        case "doppler-group":
          await dopplerFetch(this.ctx, `/v3/workplace/groups/group/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          return;
        case "doppler-service-account":
          await dopplerFetch(
            this.ctx,
            `/v3/workplace/service_accounts/service_account/${encodeURIComponent(id)}`,
            { method: "DELETE" },
          );
          return;
        case "doppler-service-account-token": {
          const [sa, token] = splitId(id, 2) as [string, string];
          await dopplerFetch(
            this.ctx,
            `/v3/workplace/service_accounts/service_account/${encodeURIComponent(sa)}/tokens/token/${encodeURIComponent(token)}`,
            { method: "DELETE" },
          );
          return;
        }
        default:
          throw new Error(`Doppler plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "doppler-config" && (actionId === "lock" || actionId === "unlock")) {
        const [project, config] = splitId(id, 2) as [string, string];
        await dopplerFetch(this.ctx, `/v3/configs/config/${actionId}`, {
          method: "POST",
          body: { project, config },
        });
        return;
      }
      if (typeId === "doppler-webhook" && (actionId === "enable" || actionId === "disable")) {
        const [project, slug] = splitId(id, 2) as [string, string];
        await dopplerFetch(
          this.ctx,
          `/v3/webhooks/webhook/${encodeURIComponent(slug)}/${actionId}`,
          {
            method: "POST",
            query: { project },
          },
        );
        return;
      }
      throw new Error(`Doppler plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const values = decodePromptArgs(args);
      const id = externalIdOf(resourceId);
      if (typeId === "doppler-config" && command === COMMANDS.cloneConfig) {
        const [project, config] = splitId(id, 2) as [string, string];
        const name = (values["name"] ?? "").trim();
        if (!name) throw new Error("Doppler plugin: enter a name for the clone");
        return dopplerFetch(this.ctx, "/v3/configs/config/clone", {
          method: "POST",
          body: { project, config, name },
        });
      }
      if (typeId === "doppler-user" && command === COMMANDS.setRole) {
        const role = (values["role"] ?? "").trim();
        if (!role) throw new Error("Doppler plugin: pick a role");
        return dopplerFetch(this.ctx, `/v3/workplace/users/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { access: role },
        });
      }
      throw new Error(`Doppler plugin: unknown command "${command}"`);
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDopplerDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderDopplerSidebar(resource);
  }
}
