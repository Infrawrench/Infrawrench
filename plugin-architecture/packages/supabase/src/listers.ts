import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { SupabaseContext } from "./api.js";
import { enc, projectUrl, sbFetch, statusOf } from "./api.js";
import {
  clean,
  instance,
  toApiKey,
  toBranch,
  toBucket,
  toFunction,
  toReadReplica,
  toSigningKey,
  toSsoProvider,
  toThirdPartyAuth,
} from "./mappers.js";
import { enabledProviders } from "./settings.js";
import type {
  SbApiKey,
  SbBackups,
  SbBranch,
  SbBucket,
  SbFunction,
  SbMember,
  SbNetworkRestrictions,
  SbOrganization,
  SbOrganizationDetail,
  SbOrgProject,
  SbOrgProjectsPage,
  SbPooler,
  SbProject,
  SbSecret,
  SbSigningKey,
  SbSsoProvider,
  SbSslEnforcement,
  SbThirdPartyAuth,
} from "./types.js";
import { listStorageBuckets } from "./storage.js";

/** Statuses in which a project's services (Auth, Storage, Edge Functions…) answer. */
export function isRunning(project: Pick<SbProject, "status">): boolean {
  return project.status === "ACTIVE_HEALTHY" || project.status === "ACTIVE_UNHEALTHY";
}

export async function fetchProjects(ctx: SupabaseContext): Promise<SbProject[]> {
  return (await sbFetch<SbProject[]>(ctx, "GET", "/v1/projects")) ?? [];
}

export async function fetchProject(ctx: SupabaseContext, ref: string): Promise<SbProject> {
  return sbFetch<SbProject>(ctx, "GET", `/v1/projects/${enc(ref)}`);
}

export async function fetchOrganizations(ctx: SupabaseContext): Promise<SbOrganization[]> {
  return (await sbFetch<SbOrganization[]>(ctx, "GET", "/v1/organizations")) ?? [];
}

/** Every project of an organization, with compute size, disk and read replicas. */
export async function fetchOrgProjects(
  ctx: SupabaseContext,
  slug: string,
): Promise<SbOrgProject[]> {
  const out: SbOrgProject[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await sbFetch<SbOrgProjectsPage>(
      ctx,
      "GET",
      `/v1/organizations/${enc(slug)}/projects`,
      undefined,
      { offset, limit },
    );
    const batch = page?.projects ?? [];
    out.push(...batch);
    const total = page?.pagination?.count ?? 0;
    if (batch.length < limit || out.length >= total) return out;
  }
}

/**
 * Run `fn` for each project and concatenate the results.
 *
 * `runningOnly` skips paused or provisioning projects, whose service
 * endpoints (Auth, Storage, Edge Functions, the pooler) answer with errors
 * rather than empty lists. A 404 for one project (the feature is not enabled
 * there) is skipped; anything else fails the whole listing, because a short
 * list would read as resources having been deleted.
 */
export async function perProject<T>(
  projects: SbProject[],
  fn: (project: SbProject) => Promise<T[]>,
  opts: { runningOnly?: boolean; tolerate?: number[] } = {},
): Promise<T[]> {
  const tolerate = new Set([404, ...(opts.tolerate ?? [])]);
  const results = await Promise.all(
    projects
      .filter((p) => !opts.runningOnly || isRunning(p))
      .map(async (p) => {
        try {
          return await fn(p);
        } catch (err) {
          if (tolerate.has(statusOf(err))) return [];
          throw err;
        }
      }),
  );
  return results.flat();
}

async function settle<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

export async function listOrganizations(
  ctx: SupabaseContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const orgs = await fetchOrganizations(ctx);
  return Promise.all(
    orgs.map(async (org) => {
      const [detail, members, projects] = await Promise.all([
        settle(sbFetch<SbOrganizationDetail>(ctx, "GET", `/v1/organizations/${enc(org.slug)}`)),
        settle(sbFetch<SbMember[]>(ctx, "GET", `/v1/organizations/${enc(org.slug)}/members`)),
        settle(fetchOrgProjects(ctx, org.slug)),
      ]);
      return instance(
        accountId,
        "supabase-organization",
        org.slug,
        org.name,
        clean({
          name: org.name,
          slug: org.slug,
          plan: detail?.plan ?? "",
          memberCount: members?.length,
          membersWithoutMfa: members ? members.filter((m) => !m.mfa_enabled).length : undefined,
          projectCount: projects?.filter((p) => !p.is_branch).length,
        }),
      );
    }),
  );
}

/** Index every database (primary and replicas) across organizations by project ref. */
export async function fetchOrgProjectIndex(
  ctx: SupabaseContext,
  slugs: string[],
): Promise<Map<string, SbOrgProject>> {
  const index = new Map<string, SbOrgProject>();
  const pages = await Promise.all(
    [...new Set(slugs)].map((slug) => settle(fetchOrgProjects(ctx, slug))),
  );
  for (const page of pages) for (const p of page ?? []) index.set(p.ref, p);
  return index;
}

/** The PRIMARY pooler entry of a project. */
export function primaryPooler(poolers: SbPooler[] | undefined): SbPooler | undefined {
  return (poolers ?? []).find((p) => p.database_type === "PRIMARY") ?? poolers?.[0];
}

const OPEN_V4 = "0.0.0.0/0";
const OPEN_V6 = "::/0";

export function networkIsOpen(net: SbNetworkRestrictions | undefined): boolean | undefined {
  if (!net) return undefined;
  const v4 = net.config.dbAllowedCidrs ?? [];
  const v6 = net.config.dbAllowedCidrsV6 ?? [];
  // An empty config is Supabase's default and allows every address.
  if (v4.length === 0 && v6.length === 0) return true;
  return v4.includes(OPEN_V4) || v6.includes(OPEN_V6);
}

export async function toProjectResource(
  ctx: SupabaseContext,
  project: SbProject,
  accountId: string,
  org: SbOrgProject | undefined,
): Promise<ResourceInstance> {
  const ref = project.ref;
  const running = isRunning(project);
  const base = `/v1/projects/${enc(ref)}`;
  const [ssl, net, backups, poolers, legacy, addons] = running
    ? await Promise.all([
        settle(sbFetch<SbSslEnforcement>(ctx, "GET", `${base}/ssl-enforcement`)),
        settle(sbFetch<SbNetworkRestrictions>(ctx, "GET", `${base}/network-restrictions`)),
        settle(sbFetch<SbBackups>(ctx, "GET", `${base}/database/backups`)),
        settle(sbFetch<SbPooler[]>(ctx, "GET", `${base}/config/database/pooler`)),
        settle(sbFetch<{ enabled: boolean }>(ctx, "GET", `${base}/api-keys/legacy`)),
        settle(
          sbFetch<{ selected_addons?: Array<{ type: string; variant: { id: string } }> }>(
            ctx,
            "GET",
            `${base}/billing/addons`,
          ),
        ),
      ])
    : [undefined, undefined, undefined, undefined, undefined, undefined];

  const primary = org?.databases.find((d) => d.type === "PRIMARY");
  const replicas = org?.databases.filter((d) => d.type === "READ_REPLICA") ?? [];
  const pooler = primaryPooler(poolers);
  const pitrVariant = addons?.selected_addons?.find((a) => a.type === "pitr")?.variant.id ?? "";
  const ipv4 = addons ? addons.selected_addons?.some((a) => a.type === "ipv4") === true : undefined;

  return instance(
    accountId,
    "supabase-project",
    ref,
    project.name,
    clean({
      name: project.name,
      ref,
      organizationSlug: project.organization_slug,
      region: project.region,
      status: project.status,
      dbHost: project.database?.host ?? `db.${ref}.supabase.co`,
      postgresVersion: project.database?.version ?? "",
      postgresEngine: project.database?.postgres_engine ?? "",
      releaseChannel: project.database?.release_channel ?? "",
      apiUrl: projectUrl(ref),
      computeSize: primary?.infra_compute_size ?? "",
      diskSizeGb: primary?.disk_volume_size_gb,
      diskType: primary?.disk_type ?? "",
      diskThroughputMbps: primary?.disk_throughput_mbps,
      pitrDays: addons ? pitrVariant.replace("pitr_", "") || "0" : undefined,
      ipv4,
      sslEnforced: ssl?.currentConfig.database,
      allowedCidrs: net ? (net.config.dbAllowedCidrs ?? []).join(", ") : undefined,
      allowedCidrsV6: net ? (net.config.dbAllowedCidrsV6 ?? []).join(", ") : undefined,
      networkOpen: networkIsOpen(net),
      poolMode: pooler?.pool_mode,
      poolSize: pooler?.default_pool_size ?? undefined,
      legacyApiKeysEnabled: legacy?.enabled,
      pitrEnabled: backups?.pitr_enabled,
      automatedBackups: backups ? backups.walg_enabled || backups.pitr_enabled : undefined,
      readReplicaCount: org ? replicas.length : undefined,
      createdAt: project.created_at,
    }),
    { createdAt: project.created_at },
  );
}

export async function listProjects(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  const index = await fetchOrgProjectIndex(
    ctx,
    projects.map((p) => p.organization_slug),
  );
  // Preview branches are projects too; they are listed as branches instead.
  const primaries = projects.filter((p) => index.get(p.ref)?.is_branch !== true);
  return Promise.all(primaries.map((p) => toProjectResource(ctx, p, accountId, index.get(p.ref))));
}

export function listBranches(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  return perProject(
    projects,
    async (p) => {
      const branches =
        (await sbFetch<SbBranch[]>(ctx, "GET", `/v1/projects/${enc(p.ref)}/branches`)) ?? [];
      // Only branches whose parent is this project: the API also answers for
      // a branch's own ref, which would list the family twice.
      return branches
        .filter((b) => b.parent_project_ref === p.ref)
        .map((b) => toBranch(b, accountId));
    },
    // Branching that was never enabled answers 400/422 rather than [].
    { tolerate: [400, 422] },
  );
}

export function listFunctions(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  return perProject(
    projects,
    async (p) =>
      ((await sbFetch<SbFunction[]>(ctx, "GET", `/v1/projects/${enc(p.ref)}/functions`)) ?? []).map(
        (fn) => toFunction(fn, p.ref, accountId),
      ),
    { runningOnly: true },
  );
}

export function listSecrets(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  return perProject(
    projects,
    async (p) =>
      ((await sbFetch<SbSecret[]>(ctx, "GET", `/v1/projects/${enc(p.ref)}/secrets`)) ?? [])
        // SUPABASE_* secrets are injected by the platform and cannot be changed.
        .filter((s) => !s.name.startsWith("SUPABASE_"))
        .map((s) =>
          instance(
            accountId,
            "supabase-secret",
            `${p.ref}/${s.name}`,
            s.name,
            clean({
              name: s.name,
              projectRef: p.ref,
              digest: s.value,
              updatedAt: s.updated_at ?? "",
            }),
            { parentTypeId: "supabase-project", parentExternalId: p.ref },
          ),
        ),
    { runningOnly: true },
  );
}

export function listApiKeys(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  return perProject(
    projects,
    async (p) =>
      ((await sbFetch<SbApiKey[]>(ctx, "GET", `/v1/projects/${enc(p.ref)}/api-keys`)) ?? []).map(
        (k) => toApiKey(k, p.ref, accountId),
      ),
    { runningOnly: true },
  );
}

export function listBuckets(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
  secretKeyFor: (ref: string) => Promise<string>,
): Promise<ResourceInstance[]> {
  return perProject(
    projects,
    async (p) => {
      // The Storage API carries the size limit and MIME allow-list the
      // Management API's bucket list leaves out; fall back to the latter when
      // no secret key is readable (a token without secrets:read).
      const viaStorage = await settle(
        (async () => listStorageBuckets(ctx, p.ref, await secretKeyFor(p.ref)))(),
      );
      const buckets =
        viaStorage ??
        (await sbFetch<SbBucket[]>(ctx, "GET", `/v1/projects/${enc(p.ref)}/storage/buckets`)) ??
        [];
      return buckets.map((b) => toBucket(b, p.ref, accountId));
    },
    { runningOnly: true },
  );
}

export function listBackups(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  return perProject(
    projects,
    async (p) => {
      const data = await sbFetch<SbBackups>(
        ctx,
        "GET",
        `/v1/projects/${enc(p.ref)}/database/backups`,
      );
      return (data?.backups ?? []).map((b) =>
        instance(
          accountId,
          "supabase-backup",
          `${p.ref}/${b.id}`,
          `${p.name} · ${b.inserted_at.slice(0, 10)}`,
          clean({
            projectRef: p.ref,
            backupId: b.id,
            status: b.status,
            physical: b.is_physical_backup,
            createdAt: b.inserted_at,
          }),
          { parentTypeId: "supabase-project", parentExternalId: p.ref, createdAt: b.inserted_at },
        ),
      );
    },
    // Free-plan projects have no backups endpoint entitlement.
    { tolerate: [400, 402, 403] },
  );
}

export async function listReadReplicas(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  const index = await fetchOrgProjectIndex(
    ctx,
    projects.map((p) => p.organization_slug),
  );
  const out: ResourceInstance[] = [];
  for (const p of projects) {
    for (const db of index.get(p.ref)?.databases ?? []) {
      if (db.type === "READ_REPLICA") out.push(toReadReplica(db, p.ref, accountId));
    }
  }
  return out;
}

export function listAuth(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  return perProject(
    projects,
    async (p) => {
      const cfg = await sbFetch<Record<string, unknown>>(
        ctx,
        "GET",
        `/v1/projects/${enc(p.ref)}/config/auth`,
      );
      return [authResource(cfg ?? {}, p, accountId)];
    },
    { runningOnly: true },
  );
}

export function authResource(
  cfg: Record<string, unknown>,
  p: Pick<SbProject, "ref" | "name">,
  accountId: string,
): ResourceInstance {
  const num = (k: string) => (typeof cfg[k] === "number" ? (cfg[k] as number) : undefined);
  return instance(
    accountId,
    "supabase-auth",
    p.ref,
    `${p.name} Auth`,
    clean({
      projectRef: p.ref,
      siteUrl: typeof cfg["site_url"] === "string" ? cfg["site_url"] : "",
      disableSignup: cfg["disable_signup"] === true,
      enabledProviders: enabledProviders(cfg).join(", "),
      passwordMinLength: num("password_min_length"),
      leakedPasswordProtection: cfg["password_hibp_enabled"] === true,
      mfaTotp: cfg["mfa_totp_enroll_enabled"] === true,
      customSmtp: typeof cfg["smtp_host"] === "string" && cfg["smtp_host"] !== "",
      jwtExpirySeconds: num("jwt_exp"),
    }),
    { parentTypeId: "supabase-project", parentExternalId: p.ref },
  );
}

export function listSsoProviders(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  return perProject(
    projects,
    async (p) => {
      const data = await sbFetch<{ items?: SbSsoProvider[] }>(
        ctx,
        "GET",
        `/v1/projects/${enc(p.ref)}/config/auth/sso/providers`,
      );
      return (data?.items ?? []).map((sp) => toSsoProvider(sp, p.ref, accountId));
    },
    // SAML SSO is a Pro-plan feature; disabled projects answer 4xx.
    { runningOnly: true, tolerate: [400, 402, 403] },
  );
}

export function listThirdPartyAuth(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  return perProject(
    projects,
    async (p) =>
      (
        (await sbFetch<SbThirdPartyAuth[]>(
          ctx,
          "GET",
          `/v1/projects/${enc(p.ref)}/config/auth/third-party-auth`,
        )) ?? []
      ).map((t) => toThirdPartyAuth(t, p.ref, accountId)),
    { runningOnly: true },
  );
}

export function listSigningKeys(
  ctx: SupabaseContext,
  accountId: string,
  projects: SbProject[],
): Promise<ResourceInstance[]> {
  return perProject(
    projects,
    async (p) => {
      const data = await sbFetch<{ keys?: SbSigningKey[] }>(
        ctx,
        "GET",
        `/v1/projects/${enc(p.ref)}/config/auth/signing-keys`,
      );
      return (data?.keys ?? []).map((k) => toSigningKey(k, p.ref, accountId));
    },
    { runningOnly: true },
  );
}
