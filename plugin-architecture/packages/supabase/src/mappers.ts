import type { ResourceInstance } from "@infrawrench/plugin-base";
import { projectUrl } from "./api.js";
import type {
  SbApiKey,
  SbBranch,
  SbFunction,
  SbOrgProjectDatabase,
  SbSigningKey,
  SbSsoProvider,
  SbStorageBucket,
  SbThirdPartyAuth,
} from "./types.js";

export const PLUGIN_ID = "supabase";

type Fields = ResourceInstance["fields"];

/** `{accountId}:{typeId}:{externalId}`: the plugin-wide resource id convention. */
export function resourceId(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

/** Drop undefined/null values so `fields` stays a clean string/number/boolean map. */
export function clean(
  fields: Record<string, string | number | boolean | null | undefined>,
): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Fields,
  opts: { parentExternalId?: string; parentTypeId?: string; createdAt?: string } = {},
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: resourceId(accountId, typeId, externalId),
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(opts.parentExternalId && opts.parentTypeId
      ? { parentResourceId: resourceId(accountId, opts.parentTypeId, opts.parentExternalId) }
      : {}),
    createdAt: opts.createdAt || now,
    updatedAt: now,
  };
}

/** Split a `{ref}/{rest}` external id. Project refs are 20 lowercase letters. */
export function splitScoped(externalId: string): { ref: string; rest: string } {
  const slash = externalId.indexOf("/");
  if (slash <= 0) return { ref: externalId, rest: "" };
  return { ref: externalId.slice(0, slash), rest: externalId.slice(slash + 1) };
}

/** Epoch milliseconds (Edge Functions report these) as ISO, or "" when unusable. */
export function epochToIso(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function toBranch(b: SbBranch, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "supabase-branch",
    `${b.parent_project_ref}/${b.id}`,
    b.name,
    clean({
      name: b.name,
      branchRef: b.project_ref,
      parentRef: b.parent_project_ref,
      gitBranch: b.git_branch ?? "",
      persistent: b.persistent,
      isDefault: b.is_default,
      withData: b.with_data,
      status: b.status,
      projectStatus: b.preview_project_status ?? "",
      prNumber: b.pr_number,
      notifyUrl: b.notify_url ?? "",
      deletionScheduledAt: b.deletion_scheduled_at ?? "",
      createdAt: b.created_at,
      updatedAt: b.updated_at,
    }),
    {
      parentTypeId: "supabase-project",
      parentExternalId: b.parent_project_ref,
      createdAt: b.created_at,
    },
  );
}

export function toFunction(fn: SbFunction, ref: string, accountId: string): ResourceInstance {
  const createdAt = epochToIso(fn.created_at);
  return instance(
    accountId,
    "supabase-function",
    `${ref}/${fn.slug}`,
    fn.name || fn.slug,
    clean({
      name: fn.name,
      slug: fn.slug,
      projectRef: ref,
      status: fn.status,
      version: fn.version,
      verifyJwt: fn.verify_jwt ?? true,
      entrypointPath: fn.entrypoint_path ?? "",
      importMap: fn.import_map ?? false,
      url: `${projectUrl(ref)}/functions/v1/${fn.slug}`,
      functionId: fn.id,
      createdAt,
      updatedAt: epochToIso(fn.updated_at),
    }),
    { parentTypeId: "supabase-project", parentExternalId: ref, createdAt },
  );
}

export function toApiKey(key: SbApiKey, ref: string, accountId: string): ResourceInstance {
  // Legacy anon/service_role keys have no id; their name is unique per project.
  const id = key.id || `legacy-${key.name}`;
  const role = key.secret_jwt_template?.["role"];
  return instance(
    accountId,
    "supabase-api-key",
    `${ref}/${id}`,
    key.name,
    clean({
      name: key.name,
      projectRef: ref,
      type: key.type ?? "legacy",
      description: key.description ?? "",
      prefix: key.prefix ?? "",
      role: typeof role === "string" ? role : "",
      createdAt: key.inserted_at ?? "",
      updatedAt: key.updated_at ?? "",
    }),
    { parentTypeId: "supabase-project", parentExternalId: ref, createdAt: key.inserted_at ?? "" },
  );
}

export function toBucket(b: SbStorageBucket, ref: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "supabase-bucket",
    `${ref}/${b.id}`,
    b.name,
    clean({
      name: b.name,
      projectRef: ref,
      public: b.public,
      fileSizeLimit: b.file_size_limit ?? undefined,
      allowedMimeTypes: (b.allowed_mime_types ?? []).join(", "),
      owner: b.owner ?? "",
      createdAt: b.created_at,
      updatedAt: b.updated_at,
    }),
    { parentTypeId: "supabase-project", parentExternalId: ref, createdAt: b.created_at },
  );
}

export function toReadReplica(
  db: SbOrgProjectDatabase,
  ref: string,
  accountId: string,
): ResourceInstance {
  return instance(
    accountId,
    "supabase-read-replica",
    `${ref}/${db.identifier}`,
    db.identifier,
    clean({
      identifier: db.identifier,
      projectRef: ref,
      region: db.region,
      status: db.status,
      computeSize: db.infra_compute_size ?? "",
      diskSizeGb: db.disk_volume_size_gb,
    }),
    { parentTypeId: "supabase-project", parentExternalId: ref },
  );
}

export function toSsoProvider(p: SbSsoProvider, ref: string, accountId: string): ResourceInstance {
  const entityId = p.saml?.entity_id ?? p.id;
  return instance(
    accountId,
    "supabase-sso-provider",
    `${ref}/${p.id}`,
    entityId,
    clean({
      entityId,
      projectRef: ref,
      metadataUrl: p.saml?.metadata_url ?? "",
      domains: (p.domains ?? [])
        .map((d) => d.domain ?? "")
        .filter(Boolean)
        .join(", "),
      nameIdFormat: p.saml?.name_id_format ?? "",
      createdAt: p.created_at ?? "",
    }),
    { parentTypeId: "supabase-project", parentExternalId: ref, createdAt: p.created_at ?? "" },
  );
}

/** "https://clerk.example.com" → "clerk.example.com"; a JWKS URL or custom JWKS otherwise. */
function thirdPartyLabel(t: SbThirdPartyAuth): string {
  const url = t.oidc_issuer_url || t.jwks_url || "";
  if (!url) return t.type || "Custom JWKS";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function toThirdPartyAuth(
  t: SbThirdPartyAuth,
  ref: string,
  accountId: string,
): ResourceInstance {
  return instance(
    accountId,
    "supabase-third-party-auth",
    `${ref}/${t.id}`,
    thirdPartyLabel(t),
    clean({
      type: t.type,
      projectRef: ref,
      oidcIssuerUrl: t.oidc_issuer_url ?? "",
      jwksUrl: t.jwks_url ?? "",
      resolvedAt: t.resolved_at ?? "",
      createdAt: t.inserted_at,
    }),
    { parentTypeId: "supabase-project", parentExternalId: ref, createdAt: t.inserted_at },
  );
}

export function toSigningKey(k: SbSigningKey, ref: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "supabase-signing-key",
    `${ref}/${k.id}`,
    `${k.algorithm} · ${k.id.slice(0, 8)}`,
    clean({
      algorithm: k.algorithm,
      projectRef: ref,
      status: k.status,
      publicJwk: k.public_jwk ? JSON.stringify(k.public_jwk) : "",
      createdAt: k.created_at,
      updatedAt: k.updated_at,
    }),
    { parentTypeId: "supabase-project", parentExternalId: ref, createdAt: k.created_at },
  );
}

/** Human status for a project or branch status enum. */
export function projectHealth(
  status: string,
): "healthy" | "degraded" | "error" | "provisioning" | "unknown" | "info" {
  switch (status) {
    case "ACTIVE_HEALTHY":
      return "healthy";
    case "ACTIVE_UNHEALTHY":
      return "degraded";
    case "INACTIVE":
      return "info";
    case "COMING_UP":
    case "RESTORING":
    case "UPGRADING":
    case "RESTARTING":
    case "RESIZING":
    case "PAUSING":
    case "GOING_DOWN":
    case "INIT_READ_REPLICA":
    case "CREATING_PROJECT":
    case "RUNNING_MIGRATIONS":
      return "provisioning";
    case "INIT_FAILED":
    case "RESTORE_FAILED":
    case "PAUSE_FAILED":
    case "REMOVED":
    case "MIGRATIONS_FAILED":
    case "FUNCTIONS_FAILED":
    case "INIT_READ_REPLICA_FAILED":
      return "error";
    case "MIGRATIONS_PASSED":
    case "FUNCTIONS_DEPLOYED":
      return "healthy";
    default:
      return "unknown";
  }
}

/** "ACTIVE_HEALTHY" → "Active (healthy)". */
export function statusLabel(status: string): string {
  if (status === "ACTIVE_HEALTHY") return "Active (healthy)";
  if (status === "ACTIVE_UNHEALTHY") return "Active (unhealthy)";
  if (status === "INACTIVE") return "Paused";
  return status
    .toLowerCase()
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}
