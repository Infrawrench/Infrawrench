import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  ArtifactEntry,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  SeatFetchOptions,
  SeatRecord,
  SeatRef,
  SeatRemovalResult,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  decodePromptArgs,
  externalIdOf,
  pathEncode,
  unencodedSegment,
  utf8ToBase64,
  type ApiBody,
} from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";
import type { HubApi, HubContext } from "./api.js";
import {
  FIRST_PAGE,
  HubApiError,
  hubApi,
  hubPaged,
  hubPagedAll,
  rawRequest,
  secretKind,
  statusOf,
} from "./api.js";
import { dockerSeatPrice, mapDockerSeats } from "./seats.js";
import type { HubMember, HubOatResource, HubOrg, HubRepository, HubTeam } from "./mappers.js";
import {
  mapInvite,
  mapMember,
  mapNamespace,
  mapOat,
  mapPat,
  mapRepository,
  mapTag,
  mapTeam,
  splitScoped,
  splitTagId,
} from "./mappers.js";
import { COMMANDS, TEAMS_KEY, renderDockerHubDetail, renderDockerHubSidebar } from "./render.js";

const enc = pathEncode;
const TAGS_PER_REPO = 25;
const MAX_TAG_REPOS = 100;

const PAT_SCOPES = [
  { id: "repo:read", label: "Read-only", description: "Pull public and private repositories" },
  { id: "repo:write", label: "Read & Write", description: "Pull and push" },
  {
    id: "repo:admin",
    label: "Read, Write & Delete",
    description: "Pull, push and delete repositories",
  },
  {
    id: "repo:public_read",
    label: "Public repositories only",
    description: "Pull public repositories",
  },
];

/** OAT scopes, from Docker's organization access token documentation (2026-10). */
const OAT_REPO_SCOPES = [
  { id: "scope-image-pull", label: "Pull images" },
  { id: "scope-image-push", label: "Push images" },
  { id: "scope-image-delete", label: "Delete images and tags (registry)" },
  { id: "scope-repository-read", label: "Read repository metadata" },
  { id: "scope-repository-edit", label: "Edit privacy, description and categories" },
  { id: "scope-repository-admin", label: "Delete the repository" },
  { id: "scope-tag-read", label: "List and read tags" },
  { id: "scope-tag-admin", label: "Delete tags" },
  { id: "scope-repository-settings-admin", label: "Configure immutable tag rules" },
];
const OAT_ORG_SCOPES = [
  { id: "scope-repository-list", label: "List all repositories, including private" },
  { id: "scope-repository-create", label: "Create repositories" },
  { id: "scope-registry-usage-read", label: "Read registry usage" },
];

const EXPIRY_OPTIONS = [
  { id: "30", label: "30 days" },
  { id: "60", label: "60 days" },
  { id: "90", label: "90 days" },
  { id: "365", label: "1 year" },
  { id: "", label: "Never" },
];

const bool = (raw: string | undefined): boolean => /^(true|yes|1|on)$/i.test((raw ?? "").trim());

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Create-form JSON-array values (`policy-picker`), tolerating a plain comma list. */
function pickList(raw: string | undefined): string[] {
  const value = (raw ?? "").trim();
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return list(value);
}

function expiryFrom(days: string | undefined): string | undefined {
  const n = Number((days ?? "").trim());
  if (!n || !Number.isFinite(n)) return undefined;
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

/** `ratelimit-limit: 200;w=21600` → `{ value: 200, window: 21600 }`. */
export function parseRateHeader(
  raw: string | undefined,
): { value: number; window?: number } | undefined {
  if (!raw) return undefined;
  const m = /^\s*(\d+)(?:\s*;\s*w=(\d+))?/.exec(raw);
  if (!m) return undefined;
  return { value: Number(m[1]), ...(m[2] ? { window: Number(m[2]) } : {}) };
}

/** Every namespace the credentials can see: the user (unless an OAT) plus their organizations. */
export async function listNamespaces(
  ctx: HubContext,
): Promise<Array<{ name: string; kind: "user" | "organization"; label?: string }>> {
  if (secretKind(ctx.secret) === "oat") return [{ name: ctx.identifier, kind: "organization" }];
  // A 401 here is a bad credential and must surface; anything else just
  // means the organization list is unavailable to this token.
  const api = hubApi(ctx);
  const orgs = await hubPaged(ctx, () => api.get("/v2/user/orgs/", FIRST_PAGE)).catch(
    (err: unknown): HubOrg[] => {
      if (statusOf(err) === 401) throw err;
      return [];
    },
  );
  return [
    { name: ctx.identifier, kind: "user" },
    ...orgs
      .filter((o) => o.orgname)
      .map((o) => ({
        name: o.orgname!,
        kind: "organization" as const,
        ...(o.full_name ? { label: o.full_name } : {}),
      })),
  ];
}

export class DockerHubClient implements PluginClient {
  private readonly ctx: HubContext;
  private readonly api: HubApi;
  private readonly services: HostServices | undefined;
  private readonly configured: string[];
  private readonly seatPriceMonthly: string | undefined;
  private namespacesCache:
    Promise<Array<{ name: string; kind: "user" | "organization" }>> | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const identifier = (credentials["username"] ?? "").trim();
    const secret = (credentials["token"] ?? "").trim();
    if (!identifier)
      throw new Error("Docker Hub plugin: missing the Docker ID (or organization name)");
    if (!secret) throw new Error("Docker Hub plugin: missing the access token");
    this.ctx = { identifier, secret, ...(services?.http ? { http: services.http } : {}) };
    this.api = hubApi(this.ctx);
    this.services = services;
    this.configured = list(credentials["namespaces"]);
    this.seatPriceMonthly = credentials["seatPriceMonthly"];
  }

  private get isOat(): boolean {
    return secretKind(this.ctx.secret) === "oat";
  }

  /** The namespaces this connection manages: the picked ones, or every one the token sees. */
  private namespaces(): Promise<Array<{ name: string; kind: "user" | "organization" }>> {
    this.namespacesCache ??= (async () => {
      const kindOf = (n: string): "user" | "organization" =>
        !this.isOat && n.toLowerCase() === this.ctx.identifier.toLowerCase()
          ? "user"
          : "organization";
      if (this.configured.length > 0)
        return this.configured.map((name) => ({ name, kind: kindOf(name) }));
      return listNamespaces(this.ctx);
    })().catch((err: unknown) => {
      this.namespacesCache = undefined;
      throw err;
    });
    return this.namespacesCache;
  }

  private async orgs(): Promise<string[]> {
    return (await this.namespaces()).filter((n) => n.kind === "organization").map((n) => n.name);
  }

  private repos(ns: string): Promise<HubRepository[]> {
    return hubPaged(this.ctx, () =>
      this.api.get(`/v2/namespaces/${enc(ns)}/repositories`, FIRST_PAGE),
    );
  }

  private repo(ns: string, name: string) {
    return this.api.get(`/v2/namespaces/${enc(ns)}/repositories/${enc(name)}`);
  }

  private teams(org: string): Promise<HubTeam[]> {
    return hubPaged(this.ctx, () => this.api.get(`/v2/orgs/${enc(org)}/groups`, FIRST_PAGE));
  }

  private members(org: string): Promise<HubMember[]> {
    return hubPaged(this.ctx, () => this.api.get(`/v2/orgs/${enc(org)}/members`, FIRST_PAGE));
  }

  private async teamMembers(org: string, team: string): Promise<string[]> {
    const members = await hubPaged(this.ctx, () =>
      this.api.get(`/v2/orgs/${enc(org)}/groups/${enc(team)}/members`, FIRST_PAGE),
    );
    return members.map((m) => m.username).filter(Boolean);
  }

  /** Run per-namespace listers, skipping organizations the token cannot read. */
  private async perOrg<T>(fn: (org: string) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (const org of await this.orgs()) {
      try {
        out.push(...(await fn(org)));
      } catch (err) {
        // A member without admin rights cannot list an org's teams or tokens.
        if (statusOf(err) === 403 || statusOf(err) === 404) continue;
        throw err;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Seats
  // -------------------------------------------------------------------------

  /**
   * Every member of every managed organization, from `GET /v2/orgs/{org}/members`
   * (https://docs.docker.com/reference/api/hub/latest/, operation getV2OrgsByOrgNameMembers;
   * fields per https://docs.docker.com/reference/api/hub/latest/schemas/org_member.md).
   * Personal namespaces have no seats. Every page of every organization or
   * nothing: unlike the resource listers, an organization the token cannot
   * read fails the pass rather than being skipped, because a skipped
   * organization would read as every one of its seats removed.
   */
  fetchSeats(_accountId: string, _options: SeatFetchOptions): PluginEffect<SeatRecord[]> {
    return attempt(async () => {
      const price = dockerSeatPrice(this.seatPriceMonthly);
      const seats: SeatRecord[] = [];
      for (const org of await this.orgs()) {
        let members: HubMember[];
        try {
          members = await hubPagedAll(this.ctx, `/v2/orgs/${enc(org)}/members`, () =>
            this.api.get(`/v2/orgs/${enc(org)}/members`, FIRST_PAGE),
          );
        } catch (err) {
          if (statusOf(err) === 403 || statusOf(err) === 404) {
            throw new HubApiError(
              statusOf(err),
              `Docker Hub plugin: cannot list the members of ${org} (${statusOf(err)}). Use an owner's token, or leave ${org} out of the account's Namespaces.`,
            );
          }
          throw err;
        }
        seats.push(...mapDockerSeats(org, members, price));
      }
      return seats;
    });
  }

  /**
   * Remove the member from the organization (and all its teams) with
   * `DELETE /v2/orgs/{org}/members/{username}`; Docker refuses the last owner.
   * https://docs.docker.com/reference/api/hub/latest/, operation deleteV2OrgsByOrgNameMembersByUsername.
   * The seat is freed, but Docker bills for purchased seats until the seat
   * count is reduced, which applies at the next billing cycle
   * (https://docs.docker.com/accounts/organization/manage/manage-seats/).
   */
  removeSeat(_accountId: string, seat: SeatRef): PluginEffect<SeatRemovalResult> {
    return attempt(async () => {
      const fromId = seat.memberId.includes("/") ? splitScoped(seat.memberId) : null;
      const org = seat.context?.["org"] || fromId?.ns || "";
      const username = seat.login || fromId?.rest || "";
      if (!org || !username)
        throw new Error("Docker Hub plugin: the seat does not name an organization and username");
      await this.api.delete(`/v2/orgs/${enc(org)}/members/${enc(username)}`);
      return {
        effective: "end-of-cycle",
        message: `Removed ${username} from ${org}. Docker keeps billing for purchased seats: reduce the seat count in Billing to stop paying for it from the next billing cycle.`,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "dockerhub-namespace": {
          const out: ResourceInstance[] = [];
          for (const ns of await this.namespaces())
            out.push(await this.namespace(accountId, ns.name, ns.kind));
          return out;
        }
        case "dockerhub-repository": {
          const out: ResourceInstance[] = [];
          for (const ns of await this.namespaces())
            out.push(...(await this.repos(ns.name)).map((r) => mapRepository(accountId, r)));
          return out;
        }
        case "dockerhub-tag": {
          const out: ResourceInstance[] = [];
          let repos = 0;
          for (const ns of await this.namespaces()) {
            for (const r of await this.repos(ns.name)) {
              if (repos++ >= MAX_TAG_REPOS) return out;
              const page = await this.api
                .get(`/v2/namespaces/${enc(ns.name)}/repositories/${enc(r.name)}/tags`, {
                  query: { page_size: TAGS_PER_REPO },
                })
                .catch(() => undefined);
              out.push(...(page?.results ?? []).map((t) => mapTag(accountId, ns.name, r.name, t)));
            }
          }
          return out;
        }
        case "dockerhub-team":
          return this.perOrg(async (org) => {
            const teams = await this.teams(org);
            const out: ResourceInstance[] = [];
            for (const t of teams) {
              const members = await this.teamMembers(org, t.name).catch(() => undefined);
              out.push(mapTeam(accountId, org, t, members));
            }
            return out;
          });
        case "dockerhub-member":
          return this.perOrg(async (org) =>
            (await this.members(org)).map((m) => mapMember(accountId, org, m)),
          );
        case "dockerhub-invite":
          return this.perOrg(async (org) => {
            const res = await this.api.get(`/v2/orgs/${enc(org)}/invites`);
            return (res?.data ?? []).map((i) => mapInvite(accountId, org, i));
          });
        case "dockerhub-access-token": {
          if (this.isOat) return [];
          return (
            await hubPaged(this.ctx, () => this.api.get("/v2/access-tokens", FIRST_PAGE))
          ).map((t) => mapPat(accountId, t));
        }
        case "dockerhub-org-access-token":
          return this.perOrg(async (org) =>
            (
              await hubPaged(this.ctx, () =>
                this.api.get(`/v2/orgs/${enc(org)}/access-tokens`, FIRST_PAGE),
              )
            ).map((t) => mapOat(accountId, org, t)),
          );
        default:
          throw new Error(`Docker Hub plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async namespace(
    accountId: string,
    ns: string,
    kind: "user" | "organization",
  ): Promise<ResourceInstance> {
    const info =
      kind === "user"
        ? await this.api.get("/v2/user/").catch(() => undefined)
        : await this.api.get(`/v2/orgs/${enc(ns)}`).catch(() => undefined);
    const repos = await this.repos(ns).catch(() => undefined);
    const stats = repos
      ? {
          repositories: repos.length,
          privateRepositories: repos.filter((r) => r.is_private).length,
          pulls: repos.reduce((n, r) => n + (r.pull_count ?? 0), 0),
          storageBytes: repos.reduce((n, r) => n + (r.storage_size ?? 0), 0),
        }
      : undefined;
    let org: Parameters<typeof mapNamespace>[5];
    if (kind === "organization") {
      const [members, teams, settings] = await Promise.all([
        this.api
          .get(`/v2/orgs/${enc(ns)}/members`, { query: { page_size: 1 } })
          .catch(() => undefined),
        this.api
          .get(`/v2/orgs/${enc(ns)}/groups`, { query: { page_size: 1 } })
          .catch(() => undefined),
        this.api.get(`/v2/orgs/${enc(ns)}/settings`).catch(() => undefined),
      ]);
      org = {
        ...(members?.count !== undefined ? { members: members.count } : {}),
        ...(teams?.count !== undefined ? { teams: teams.count } : {}),
        ...(settings?.restricted_images ? { restricted: settings.restricted_images } : {}),
      };
    }
    return mapNamespace(accountId, ns, kind, info, stats, org);
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
      switch (typeId) {
        case "dockerhub-namespace": {
          const ns = (await this.namespaces()).find((n) => n.name === id);
          return this.namespace(accountId, id, ns?.kind ?? "organization");
        }
        case "dockerhub-repository": {
          const { ns, rest } = splitScoped(id);
          const r = mapRepository(accountId, await this.repo(ns, rest));
          const isOrg = (await this.orgs()).includes(ns);
          if (!isOrg) return r;
          const teams = await this.teams(ns).catch((): HubTeam[] => []);
          const slim = teams
            .filter((t) => t.id !== undefined)
            .map((t) => ({ id: t.id, name: t.name }));
          return slim.length
            ? { ...r, resolvedOutputs: { ...r.resolvedOutputs, [TEAMS_KEY]: JSON.stringify(slim) } }
            : r;
        }
        case "dockerhub-tag": {
          const { ns, repo, tag } = splitTagId(id);
          const t = await this.api.get(
            `/v2/namespaces/${enc(ns)}/repositories/${enc(repo)}/tags/${enc(tag)}`,
          );
          return mapTag(accountId, ns, repo, t);
        }
        case "dockerhub-team": {
          const { ns, rest } = splitScoped(id);
          const t = await this.api.get(`/v2/orgs/${enc(ns)}/groups/${enc(rest)}`);
          return mapTeam(accountId, ns, t, await this.teamMembers(ns, rest).catch(() => undefined));
        }
        case "dockerhub-member": {
          const { ns, rest } = splitScoped(id);
          const members = await this.members(ns);
          const m = members.find((x) => x.username === rest);
          if (!m) throw new HubApiError(404, `Docker Hub plugin: ${rest} is not a member of ${ns}`);
          return mapMember(accountId, ns, m);
        }
        case "dockerhub-invite": {
          for (const org of await this.orgs()) {
            const res = await this.api.get(`/v2/orgs/${enc(org)}/invites`).catch(() => undefined);
            const hit = res?.data?.find((i) => i.id === id);
            if (hit) return mapInvite(accountId, org, hit);
          }
          throw new HubApiError(404, `Docker Hub plugin: invite ${id} not found`);
        }
        case "dockerhub-access-token":
          return mapPat(accountId, await this.api.get(`/v2/access-tokens/${enc(id)}`));
        case "dockerhub-org-access-token": {
          const { ns, rest } = splitScoped(id);
          return mapOat(
            accountId,
            ns,
            await this.api.get(`/v2/orgs/${enc(ns)}/access-tokens/${enc(rest)}`),
          );
        }
        default:
          throw new Error(`Docker Hub plugin: unknown resource type "${typeId}"`);
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
      if (
        outputKey === "token" &&
        (typeId === "dockerhub-access-token" || typeId === "dockerhub-org-access-token")
      ) {
        const value = await this.services?.secrets?.getPlaintext(resourceId, "token");
        if (value) return value;
        throw new Error(
          "Docker Hub plugin: the token's value is only kept for tokens created from Infrawrench.",
        );
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      throw new Error(
        `Docker Hub plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, quotas, logs, tags tab
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");
      if (resourceTypeId === "dockerhub-repository") {
        return [
          { label: "Pulls", value: n(r.fields["pullCount"]) },
          { label: "Stars", value: n(r.fields["starCount"]) },
        ];
      }
      if (resourceTypeId === "dockerhub-namespace") {
        return [
          { label: "Repositories", value: n(r.fields["repositories"]) },
          { label: "Pulls", value: n(r.fields["totalPulls"]) },
        ];
      }
      return [];
    });
  }

  /**
   * Docker Hub reports lifetime pull and star counts and current storage, not
   * a history, so each series is one reading stamped now; the host's stored
   * readings turn them into a trend (and pull deltas into a pull rate).
   */
  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      const now = Date.now();
      const pt = (label: string, unit: string, v: unknown): MetricSeries[] =>
        typeof v === "number" ? [{ label, unit, points: [{ timestamp: now, value: v }] }] : [];
      if (resourceTypeId === "dockerhub-repository") {
        return [
          ...pt("Pulls (lifetime)", "count", r.fields["pullCount"]),
          ...pt("Stars", "count", r.fields["starCount"]),
          ...pt("Storage", "bytes", r.fields["storageSize"]),
        ];
      }
      if (resourceTypeId === "dockerhub-namespace") {
        return [
          ...pt("Pulls (lifetime)", "count", r.fields["totalPulls"]),
          ...pt("Repositories", "count", r.fields["repositories"]),
          ...pt("Storage", "bytes", r.fields["storageBytes"]),
        ];
      }
      return [];
    });
  }

  /**
   * The pull rate limit, read the way Docker documents it: a registry token
   * for `ratelimitpreview/test` authenticated as this account, then a HEAD on
   * its manifest, whose `ratelimit-limit` / `ratelimit-remaining` headers carry
   * the 6-hour window. Paid plans get no headers (unlimited), so nothing is
   * returned rather than a made-up limit.
   */
  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const auth = await rawRequest(
        this.ctx.http,
        "https://auth.docker.io/token?service=registry.docker.io&scope=repository:ratelimitpreview/test:pull",
        "GET",
        { Authorization: `Basic ${utf8ToBase64(`${this.ctx.identifier}:${this.ctx.secret}`)}` },
      );
      if (auth.status < 200 || auth.status >= 300) {
        throw new HubApiError(auth.status, `Docker Hub registry auth failed (${auth.status})`);
      }
      const answer: { token?: string } = JSON.parse(auth.text);
      const token = answer.token ?? "";
      const head = await rawRequest(
        this.ctx.http,
        "https://registry-1.docker.io/v2/ratelimitpreview/test/manifests/latest",
        "HEAD",
        {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.docker.distribution.manifest.v2+json",
        },
      );
      const limit = parseRateHeader(head.headers["ratelimit-limit"]);
      const remaining = parseRateHeader(head.headers["ratelimit-remaining"]);
      if (!limit || !remaining) return [];
      const hours = limit.window ? Math.round(limit.window / 3600) : 6;
      return [
        {
          id: "pull-rate-limit",
          service: "Registry",
          name: `Image pulls per ${hours} hours`,
          limit: limit.value,
          used: Math.max(0, limit.value - remaining.value),
          unit: "pulls",
          adjustable: true,
          docsUrl: "https://docs.docker.com/docker-hub/usage/pulls/",
        },
      ];
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      if (typeId !== "dockerhub-namespace")
        return { text: "", containers: [], activeContainer: "" };
      const ns = externalIdOf(resourceId);
      const res = await this.api.get(`/v2/auditlogs/${enc(ns)}`, {
        query: { page_size: Math.min(params.tailLines ?? 100, 100) },
      });
      const lines = (res?.logs ?? [])
        .slice()
        .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""))
        .map(
          (l) =>
            `${l.timestamp ?? ""}  ${l.actor ?? "?"}  ${l.action ?? ""}  ${l.name ?? ""}${l.action_description ? `  ${l.action_description}` : ""}\n`,
        );
      return { text: lines.join(""), containers: ["audit log"], activeContainer: "audit log" };
    });
  }

  listArtifacts(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params?: { pageToken?: string; prefix?: string },
  ): PluginEffect<{ items: ArtifactEntry[]; nextPageToken?: string }> {
    return attempt(async () => {
      if (typeId !== "dockerhub-repository") return { items: [] };
      const { ns, rest } = splitScoped(externalIdOf(resourceId));
      const page = Number(params?.pageToken ?? "1") || 1;
      const res = await this.api.get(`/v2/namespaces/${enc(ns)}/repositories/${enc(rest)}/tags`, {
        query: { page, page_size: 100, ...(params?.prefix ? { name: params.prefix } : {}) },
      });
      const items = (res?.results ?? []).map<ArtifactEntry>((t) => {
        const digest = t.digest ?? t.images?.[0]?.digest ?? undefined;
        return {
          name: `${ns}/${rest}`,
          version: t.name,
          tags: [t.name],
          ...(digest ? { digest } : {}),
          ...(t.full_size !== undefined ? { sizeBytes: t.full_size } : {}),
          ...(t.tag_last_pushed || t.last_updated
            ? { updatedAt: (t.tag_last_pushed ?? t.last_updated)! }
            : {}),
          ...(t.media_type ? { mediaType: t.media_type } : {}),
        };
      });
      return { items, ...(res?.next ? { nextPageToken: String(page + 1) } : {}) };
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      const parentNs = parentResourceId ? externalIdOf(parentResourceId) : undefined;
      const nsField = async (orgsOnly: boolean) => {
        if (parentNs) return [];
        const all = (await this.namespaces().catch(() => [])).filter(
          (n) => !orgsOnly || n.kind === "organization",
        );
        return [
          {
            key: "namespace",
            label: orgsOnly ? "Organization" : "Namespace",
            kind: "select" as const,
            required: true,
            ...(all[0] ? { defaultValue: all[0].name } : {}),
            options: all.map((n) => ({ id: n.name, label: n.name, description: n.kind })),
          },
        ];
      };
      switch (typeId) {
        case "dockerhub-repository":
          return {
            fields: [
              ...(await nsField(false)),
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "api",
                description: "Lowercase letters, digits, and . _ -",
              },
              { key: "description", label: "Short description", kind: "text", required: false },
              {
                key: "fullDescription",
                label: "Overview (Markdown)",
                kind: "text",
                multiline: true,
                required: false,
              },
              {
                key: "visibility",
                label: "Visibility",
                kind: "select",
                required: true,
                defaultValue: "private",
                options: [
                  { id: "private", label: "Private", description: "Only people you grant access" },
                  { id: "public", label: "Public", description: "Anyone can pull" },
                ],
              },
            ],
          };
        case "dockerhub-team":
          return {
            fields: [
              ...(await nsField(true)),
              { key: "name", label: "Name", kind: "text", required: true, placeholder: "backend" },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case "dockerhub-invite": {
          const org = parentNs ?? (await this.orgs().catch(() => []))[0];
          const teams = org ? await this.teams(org).catch((): HubTeam[] => []) : [];
          return {
            fields: [
              ...(await nsField(true)),
              {
                key: "invitees",
                label: "People",
                kind: "string-list",
                required: true,
                description: "Docker IDs or email addresses.",
              },
              {
                key: "role",
                label: "Role",
                kind: "select",
                required: true,
                defaultValue: "member",
                options: [
                  { id: "member", label: "Member" },
                  { id: "editor", label: "Editor" },
                  { id: "owner", label: "Owner" },
                ],
              },
              {
                key: "team",
                label: "Team",
                kind: "select",
                required: false,
                options: [
                  { id: "", label: "No team" },
                  ...teams.map((t) => ({ id: t.name, label: t.name })),
                ],
              },
            ],
          };
        }
        case "dockerhub-access-token":
          return {
            fields: [
              {
                key: "label",
                label: "Label",
                kind: "text",
                required: true,
                placeholder: "CI pulls",
              },
              {
                key: "scope",
                label: "Access",
                kind: "select",
                required: true,
                defaultValue: "repo:read",
                options: PAT_SCOPES,
              },
              {
                key: "expiresInDays",
                label: "Expires after",
                kind: "select",
                required: false,
                defaultValue: "90",
                options: EXPIRY_OPTIONS,
              },
            ],
          };
        case "dockerhub-org-access-token": {
          const org = parentNs ?? (await this.orgs().catch(() => []))[0];
          const repos = org ? await this.repos(org).catch((): HubRepository[] => []) : [];
          return {
            fields: [
              ...(await nsField(true)),
              {
                key: "label",
                label: "Label",
                kind: "text",
                required: true,
                placeholder: "deploy-bot",
              },
              { key: "description", label: "Description", kind: "text", required: false },
              {
                key: "repositories",
                label: "Repositories",
                kind: "policy-picker",
                required: false,
                description: "Which repositories the token reaches.",
                policies: [
                  ...(org
                    ? [{ id: `${org}/*`, label: `All ${org} repositories`, category: "Patterns" }]
                    : []),
                  { id: "*/*/public", label: "All public repositories", category: "Patterns" },
                  ...repos.map((r) => ({
                    id: `${r.namespace}/${r.name}`,
                    label: r.name,
                    category: r.is_private ? "Private" : "Public",
                  })),
                ],
              },
              {
                key: "repoScopes",
                label: "Repository permissions",
                kind: "policy-picker",
                required: false,
                defaultValue: '["scope-image-pull"]',
                policies: OAT_REPO_SCOPES,
              },
              {
                key: "orgScopes",
                label: "Organization permissions",
                kind: "policy-picker",
                required: false,
                policies: OAT_ORG_SCOPES,
              },
              {
                key: "expiresInDays",
                label: "Expires after",
                kind: "select",
                required: false,
                defaultValue: "90",
                options: EXPIRY_OPTIONS,
              },
            ],
          };
        }
        default:
          throw new Error(`Docker Hub plugin: cannot create "${typeId}" from Infrawrench`);
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
      const ns = parentResourceId ? externalIdOf(parentResourceId) : text("namespace");
      switch (typeId) {
        case "dockerhub-repository": {
          const name = text("name");
          if (!ns || !name) throw new Error("Docker Hub plugin: pick a namespace and enter a name");
          const r = await this.api.post(`/v2/namespaces/${enc(ns)}/repositories`, {
            body: {
              name,
              namespace: ns,
              description: text("description"),
              full_description: fields["fullDescription"] ?? "",
              registry: "docker.io",
              is_private: text("visibility") !== "public",
            },
          });
          return mapRepository(accountId, r?.name ? r : await this.repo(ns, name));
        }
        case "dockerhub-team": {
          const name = text("name");
          if (!ns || !name)
            throw new Error("Docker Hub plugin: pick an organization and enter a name");
          const t = await this.api.post(`/v2/orgs/${enc(ns)}/groups`, {
            body: { name, description: text("description") },
          });
          return mapTeam(accountId, ns, t?.name ? t : { name }, []);
        }
        case "dockerhub-invite": {
          const invitees = pickList(fields["invitees"]);
          if (!ns || invitees.length === 0)
            throw new Error("Docker Hub plugin: pick an organization and enter who to invite");
          const res = await this.api.post("/v2/invites/bulk", {
            body: {
              org: ns,
              role: text("role") || "member",
              invitees,
              ...(text("team") ? { team: text("team") } : {}),
            },
          });
          const results = res?.invitees ?? [];
          const failed = results
            .filter((i) => !i.invite)
            .map((i) => `${i.invitee ?? "?"}: ${i.status ?? "not invited"}`);
          const first = results.find((i) => i.invite)?.invite;
          if (!first)
            throw new HubApiError(
              400,
              `Docker Hub plugin: no invite was created (${failed.join("; ") || "no response"})`,
            );
          return mapInvite(accountId, ns, first);
        }
        case "dockerhub-access-token": {
          const expires = expiryFrom(fields["expiresInDays"]);
          const t = await this.api.post("/v2/access-tokens", {
            body: {
              token_label: text("label"),
              scopes: [text("scope") || "repo:read"],
              ...(expires ? { expires_at: expires } : {}),
            },
          });
          const r = mapPat(accountId, t);
          return t.token
            ? {
                ...r,
                resolvedOutputs: { ...r.resolvedOutputs, token: t.token },
                secretStates: [
                  { fieldKey: "token", resolution: { kind: "plaintext", value: t.token } },
                ],
              }
            : r;
        }
        case "dockerhub-org-access-token": {
          if (!ns) throw new Error("Docker Hub plugin: pick an organization");
          const resources: HubOatResource[] = [];
          const repoScopes = pickList(fields["repoScopes"]);
          for (const path of pickList(fields["repositories"])) {
            resources.push({
              type: "TYPE_REPO",
              path,
              scopes: repoScopes.length ? repoScopes : ["scope-image-pull"],
            });
          }
          const orgScopes = pickList(fields["orgScopes"]);
          if (orgScopes.length) resources.push({ type: "TYPE_ORG", path: ns, scopes: orgScopes });
          if (resources.length === 0)
            throw new Error(
              "Docker Hub plugin: give the token at least one repository or organization permission",
            );
          const expires = expiryFrom(fields["expiresInDays"]);
          const t = await this.api.post(`/v2/orgs/${enc(ns)}/access-tokens`, {
            body: {
              label: text("label"),
              description: text("description"),
              resources,
              expires_at: expires ?? null,
            },
          });
          const r = mapOat(accountId, ns, t);
          const token = t.token;
          return token
            ? {
                ...r,
                resolvedOutputs: { ...r.resolvedOutputs, token },
                secretStates: [
                  { fieldKey: "token", resolution: { kind: "plaintext", value: token } },
                ],
              }
            : r;
        }
        default:
          throw new Error(`Docker Hub plugin: cannot create "${typeId}" from Infrawrench`);
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
      switch (typeId) {
        case "dockerhub-namespace": {
          if (
            has("restrictedImages") ||
            has("allowOfficialImages") ||
            has("allowVerifiedPublishers")
          ) {
            const current = await this.api.get(`/v2/orgs/${enc(id)}/settings`);
            const ri = {
              enabled: false,
              allow_official_images: true,
              allow_verified_publishers: true,
              ...(current?.restricted_images ?? {}),
            };
            if (has("restrictedImages")) ri.enabled = bool(fields["restrictedImages"]);
            if (has("allowOfficialImages"))
              ri.allow_official_images = bool(fields["allowOfficialImages"]);
            if (has("allowVerifiedPublishers"))
              ri.allow_verified_publishers = bool(fields["allowVerifiedPublishers"]);
            await this.api.put(`/v2/orgs/${enc(id)}/settings`, {
              body: { restricted_images: ri },
            });
          }
          break;
        }
        case "dockerhub-repository": {
          const { ns, rest } = splitScoped(id);
          if (has("description") || has("fullDescription")) {
            // The PATCH writes both descriptions; send the untouched one back.
            const current = await this.repo(ns, rest);
            await this.api.patch(`/v2/repositories/${enc(ns)}/${enc(rest)}/`, {
              body: {
                description: has("description") ? text("description") : (current.description ?? ""),
                full_description: has("fullDescription")
                  ? (fields["fullDescription"] ?? "")
                  : (current.full_description ?? ""),
              },
            });
          }
          if (has("isPrivate")) {
            await this.api.post(`/v2/repositories/${enc(ns)}/${enc(rest)}/privacy`, {
              body: { is_private: bool(fields["isPrivate"]) },
            });
          }
          if (has("immutableTags") || has("immutableTagsRules")) {
            const current = await this.repo(ns, rest);
            const enabled = has("immutableTags")
              ? bool(fields["immutableTags"])
              : (current.immutable_tags_settings?.enabled ?? false);
            const rules = has("immutableTagsRules")
              ? list(fields["immutableTagsRules"])
              : (current.immutable_tags_settings?.rules ?? []);
            await this.api.patch(
              `/v2/namespaces/${enc(ns)}/repositories/${enc(rest)}/immutabletags`,
              {
                body: {
                  immutable_tags: enabled,
                  ...(rules.length ? { immutable_tags_rules: rules } : {}),
                },
              },
            );
          }
          break;
        }
        case "dockerhub-team": {
          const { ns, rest } = splitScoped(id);
          let name = rest;
          const body: ApiBody<operations["patchV2OrgsByOrgNameGroupsByGroupName"]> = {};
          if (has("name") && text("name") && text("name") !== rest) body.name = text("name");
          if (has("description")) body.description = text("description");
          if (Object.keys(body).length > 0) {
            await this.api.patch(`/v2/orgs/${enc(ns)}/groups/${enc(rest)}`, { body });
            if (body.name) name = body.name;
          }
          if (has("members")) {
            const current = new Set(await this.teamMembers(ns, name));
            const wanted = new Set(list(fields["members"]));
            for (const m of wanted) {
              if (!current.has(m)) {
                await this.api.post(`/v2/orgs/${enc(ns)}/groups/${enc(name)}/members`, {
                  body: { member: m },
                });
              }
            }
            for (const m of current) {
              if (!wanted.has(m)) {
                await this.api.delete(`/v2/orgs/${enc(ns)}/groups/${enc(name)}/members/${enc(m)}`);
              }
            }
          }
          return runPluginEffect(
            this.getResource(typeId, `${accountId}:${typeId}:${ns}/${name}`, accountId),
          );
        }
        case "dockerhub-member": {
          const { ns, rest } = splitScoped(id);
          if (has("role") && text("role")) {
            await this.api.put(`/v2/orgs/${enc(ns)}/members/${enc(rest)}`, {
              body: { role: text("role") },
            });
          }
          break;
        }
        case "dockerhub-access-token":
          if (has("label") && text("label")) {
            await this.api.patch(`/v2/access-tokens/${enc(id)}`, {
              body: { token_label: text("label") },
            });
          }
          break;
        case "dockerhub-org-access-token": {
          const { ns, rest } = splitScoped(id);
          const body: ApiBody<operations["patchV2OrgsByOrgNameAccessTokensByAccessTokenId"]> = {};
          if (has("label") && text("label")) body.label = text("label");
          if (has("description")) body.description = text("description");
          if (Object.keys(body).length > 0) {
            await this.api.patch(`/v2/orgs/${enc(ns)}/access-tokens/${enc(rest)}`, { body });
          }
          break;
        }
        default:
          throw new Error(`Docker Hub plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "dockerhub-repository": {
          const { ns, rest } = splitScoped(id);
          await this.api.delete(`/v2/repositories/${enc(ns)}/${enc(rest)}/`);
          return;
        }
        case "dockerhub-tag": {
          const { ns, repo, tag } = splitTagId(id);
          await this.api.delete(`/v2/repositories/${enc(ns)}/${enc(repo)}/tags/${enc(tag)}/`);
          return;
        }
        case "dockerhub-team": {
          const { ns, rest } = splitScoped(id);
          await this.api.delete(`/v2/orgs/${enc(ns)}/groups/${enc(rest)}`);
          return;
        }
        case "dockerhub-member": {
          const { ns, rest } = splitScoped(id);
          await this.api.delete(`/v2/orgs/${enc(ns)}/members/${enc(rest)}`);
          return;
        }
        case "dockerhub-invite":
          await this.api.delete(`/v2/invites/${enc(id)}`);
          return;
        case "dockerhub-access-token":
          await this.api.delete(`/v2/access-tokens/${enc(id)}`);
          return;
        case "dockerhub-org-access-token": {
          const { ns, rest } = splitScoped(id);
          await this.api.delete(`/v2/orgs/${enc(ns)}/access-tokens/${enc(rest)}`);
          return;
        }
        default:
          throw new Error(`Docker Hub plugin: "${typeId}" cannot be deleted from Infrawrench`);
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
      const active = actionId === "activate";
      if (actionId === "activate" || actionId === "deactivate") {
        if (typeId === "dockerhub-access-token") {
          await this.api.patch(`/v2/access-tokens/${enc(id)}`, {
            body: { is_active: active },
          });
          return;
        }
        if (typeId === "dockerhub-org-access-token") {
          const { ns, rest } = splitScoped(id);
          await this.api.patch(`/v2/orgs/${enc(ns)}/access-tokens/${enc(rest)}`, {
            body: { is_active: active },
          });
          return;
        }
      }
      if (typeId === "dockerhub-invite" && actionId === "resend") {
        await this.api.patch(`/v2/invites/${enc(id)}/resend`);
        return;
      }
      throw new Error(`Docker Hub plugin: unknown action "${actionId}" for "${typeId}"`);
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
      if (typeId !== "dockerhub-repository" || command !== COMMANDS.grantTeam) {
        throw new Error(`Docker Hub plugin: unknown command "${command}"`);
      }
      const values = decodePromptArgs(args);
      const teamId = Number(values["teamId"]);
      const permission = values["permission"] || "read";
      if (!Number.isFinite(teamId)) throw new Error("Docker Hub plugin: pick a team");
      const { ns, rest } = splitScoped(externalIdOf(resourceId));
      try {
        return await this.api.post(`/v2/repositories/${enc(ns)}/${enc(rest)}/groups`, {
          body: { group_id: teamId, permission },
        });
      } catch (err) {
        // The team already has a permission here: change it instead.
        if (statusOf(err) !== 400 && statusOf(err) !== 409) throw err;
        // The id goes in as JavaScript writes the number, `1e+21` included.
        const group = unencodedSegment(String(teamId));
        return await this.api.patch(`/v2/repositories/${enc(ns)}/${enc(rest)}/groups/${group}/`, {
          body: { permission },
        });
      }
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDockerHubDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderDockerHubSidebar(resource);
  }
}
