/**
 * Custom hostnames for public status pages — Cloudflare for SaaS + Workers KV.
 *
 * Customers CNAME a subdomain at Infrawrench; we create a Cloudflare Custom
 * Hostname (TLS + ownership) and write `hostname → slug` into the KV the
 * status-page-edge Worker reads. The Worker is the origin for those vanity
 * hosts; this module never serves traffic itself.
 *
 * Env (all required to attach; feature returns a clear error when unset):
 *   STATUS_PAGE_CF_ACCOUNT_ID
 *   STATUS_PAGE_CF_ZONE_ID
 *   STATUS_PAGE_CF_API_TOKEN
 *   STATUS_PAGE_CNAME_TARGET
 *   STATUS_PAGE_KV_NAMESPACE_ID
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import {
  type StatusPage,
  type StatusPageCustomHostnameStatus,
  type StatusPageHostnameVerification,
} from "@infrawrench/client-core";
import { requirePaidPlan, PlanRequiredError } from "../entitlements";
import { db } from "../db/client";
import { statusPages } from "../db/schema";
import { StatusPageInputError, getStatusPageWire } from "./store";

export { PlanRequiredError };

interface CfConfig {
  accountId: string;
  zoneId: string;
  apiToken: string;
  cnameTarget: string;
  kvNamespaceId: string;
}

function readConfig(): CfConfig | null {
  const accountId = process.env["STATUS_PAGE_CF_ACCOUNT_ID"]?.trim();
  const zoneId = process.env["STATUS_PAGE_CF_ZONE_ID"]?.trim();
  const apiToken = process.env["STATUS_PAGE_CF_API_TOKEN"]?.trim();
  const cnameTarget = process.env["STATUS_PAGE_CNAME_TARGET"]?.trim();
  const kvNamespaceId = process.env["STATUS_PAGE_KV_NAMESPACE_ID"]?.trim();
  if (!accountId || !zoneId || !apiToken || !cnameTarget || !kvNamespaceId) return null;
  return { accountId, zoneId, apiToken, cnameTarget, kvNamespaceId };
}

function requireConfig(): CfConfig {
  const cfg = readConfig();
  if (!cfg) {
    throw new StatusPageInputError(
      "Custom domains are not configured on this deployment. Ask your admin to set the STATUS_PAGE_CF_* environment variables.",
      400,
    );
  }
  return cfg;
}

/**
 * Accept only a subdomain FQDN — no apex, no wildcards, no scheme/path.
 * Apex needs ALIAS/A flattening and is out of scope for v1.
 */
export function normalizeCustomHostname(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) throw new StatusPageInputError("Hostname is required");
  if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes(":")) {
    throw new StatusPageInputError("Enter a hostname only, e.g. status.example.com");
  }
  if (trimmed.includes("*")) {
    throw new StatusPageInputError("Wildcard hostnames are not supported");
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) {
    throw new StatusPageInputError("That does not look like a valid hostname");
  }
  const labels = trimmed.split(".");
  // At least subdomain + registrable domain (e.g. status.acme.com → 3 labels).
  // Two labels is an apex (acme.com) — rejected.
  if (labels.length < 3) {
    throw new StatusPageInputError(
      "Use a subdomain (e.g. status.example.com). Apex domains are not supported yet.",
    );
  }
  return trimmed;
}

interface CfOwnershipVerification {
  type?: string;
  name?: string;
  value?: string;
}

interface CfCustomHostname {
  id: string;
  hostname: string;
  status: string;
  verification_errors?: string[];
  ownership_verification?: CfOwnershipVerification;
  ssl?: { status?: string; validation_errors?: Array<{ message?: string }> };
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ message?: string; code?: number }>;
  result?: T;
}

async function cfFetch<T>(cfg: CfConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as CfEnvelope<T>;
  if (!res.ok || !json.success || json.result === undefined) {
    const msg =
      json.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join("; ") || `Cloudflare API ${res.status}`;
    throw new StatusPageInputError(`Cloudflare: ${msg}`, 400);
  }
  return json.result;
}

async function createCfHostname(cfg: CfConfig, hostname: string): Promise<CfCustomHostname> {
  return cfFetch<CfCustomHostname>(cfg, "POST", `/zones/${cfg.zoneId}/custom_hostnames`, {
    hostname,
    ssl: {
      method: "http",
      type: "dv",
      settings: { http2: "on", min_tls_version: "1.2" },
    },
  });
}

async function getCfHostname(cfg: CfConfig, id: string): Promise<CfCustomHostname> {
  return cfFetch<CfCustomHostname>(
    cfg,
    "GET",
    `/zones/${cfg.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
  );
}

async function deleteCfHostname(cfg: CfConfig, id: string): Promise<void> {
  try {
    await cfFetch<unknown>(
      cfg,
      "DELETE",
      `/zones/${cfg.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
    );
  } catch (err) {
    // Already gone is fine — we still clear local state.
    if (err instanceof StatusPageInputError && /10007|404|not found/i.test(err.message)) return;
    throw err;
  }
}

async function kvPut(cfg: CfConfig, hostname: string, slug: string): Promise<void> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(hostname)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        "Content-Type": "text/plain",
      },
      body: slug,
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new StatusPageInputError(
      `Failed to publish hostname mapping: ${text || res.status}`,
      400,
    );
  }
}

async function kvDelete(cfg: CfConfig, hostname: string): Promise<void> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(hostname)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${cfg.apiToken}` },
    },
  );
  // 404 = already gone.
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new StatusPageInputError(`Failed to remove hostname mapping: ${text || res.status}`, 400);
  }
}

export function mapCfStatus(ch: CfCustomHostname): {
  status: StatusPageCustomHostnameStatus;
  error: string | null;
} {
  const hostnameActive = ch.status === "active";
  const sslStatus = ch.ssl?.status ?? "";
  const sslActive = sslStatus === "active";
  // A fresh hostname has no validation_errors array at all — Cloudflare only
  // includes it once validation has failed at least once.
  const sslErrors = (ch.ssl?.validation_errors ?? [])
    .map((e) => e.message)
    .filter((m): m is string => Boolean(m));
  const errors = [...(ch.verification_errors ?? []), ...sslErrors].filter(Boolean);

  if (hostnameActive && sslActive) return { status: "active", error: null };
  if (errors.length > 0 && ch.status === "moved" /* unlikely */) {
    return { status: "error", error: errors.join("; ") };
  }
  if (!hostnameActive) {
    return {
      status: "pending_dns",
      error: errors.length > 0 ? errors.join("; ") : null,
    };
  }
  return {
    status: "pending_ssl",
    error: errors.length > 0 ? errors.join("; ") : null,
  };
}

function verificationFrom(cfg: CfConfig, ch: CfCustomHostname): StatusPageHostnameVerification {
  const ov = ch.ownership_verification;
  return {
    cnameTarget: cfg.cnameTarget,
    ...(ov?.name && ov?.value ? { txtName: ov.name, txtValue: ov.value } : {}),
  };
}

async function persistHostnameFields(
  pageId: string,
  fields: {
    customHostname: string | null;
    customHostnameStatus: StatusPageCustomHostnameStatus;
    cloudflareCustomHostnameId: string | null;
    customHostnameError: string | null;
    customHostnameVerification: StatusPageHostnameVerification | null;
  },
): Promise<void> {
  await db
    .update(statusPages)
    .set({
      customHostname: fields.customHostname,
      customHostnameStatus: fields.customHostnameStatus,
      cloudflareCustomHostnameId: fields.cloudflareCustomHostnameId,
      customHostnameError: fields.customHostnameError,
      customHostnameVerification: fields.customHostnameVerification,
      updatedAt: new Date(),
    })
    .where(eq(statusPages.id, pageId));
}

/**
 * Recovery write after a failed attach — only fills an empty hostname slot so
 * a concurrent successful attach cannot be overwritten.
 *
 * @returns true when this page accepted the recovery row.
 */
async function persistHostnameRecoveryIfUnset(
  pageId: string,
  fields: {
    customHostname: string;
    customHostnameStatus: StatusPageCustomHostnameStatus;
    cloudflareCustomHostnameId: string;
    customHostnameError: string | null;
    customHostnameVerification: StatusPageHostnameVerification | null;
  },
): Promise<boolean> {
  const updated = await db
    .update(statusPages)
    .set({
      customHostname: fields.customHostname,
      customHostnameStatus: fields.customHostnameStatus,
      cloudflareCustomHostnameId: fields.cloudflareCustomHostnameId,
      customHostnameError: fields.customHostnameError,
      customHostnameVerification: fields.customHostnameVerification,
      updatedAt: new Date(),
    })
    .where(and(eq(statusPages.id, pageId), isNull(statusPages.customHostname)))
    .returning({ id: statusPages.id });
  return updated.length > 0;
}

/** Keep Workers KV in sync when the slug changes (hostname unchanged). */
export async function syncCustomHostnameKvForPage(
  page: Pick<StatusPage, "customHostname" | "slug">,
): Promise<void> {
  if (!page.customHostname) return;
  // Hostname exists → CF was configured when it was attached. Missing config
  // must fail the rotation so we never leave a live KV mapping on the old slug.
  const cfg = requireConfig();
  await kvPut(cfg, page.customHostname, page.slug);
}

/**
 * Remove the Cloudflare Custom Hostname and KV mapping.
 *
 * Failures propagate: callers must not clear the local hostname columns (or
 * delete the page) until this succeeds, or the external resources become
 * unrecoverable orphans that still answer on the vanity host.
 */
export async function removeCustomHostnameInfra(
  hostname: string | null,
  cfId: string | null,
): Promise<void> {
  if (!hostname && !cfId) return;
  // Hostname/CF id present means attach succeeded earlier — missing config
  // must fail so callers keep local identifiers and can retry revocation.
  const cfg = requireConfig();
  // KV first so a CF delete that succeeds cannot leave a live mapping.
  if (hostname) await kvDelete(cfg, hostname);
  if (cfId) await deleteCfHostname(cfg, cfId);
}

export async function attachCustomHostname(
  organizationId: string,
  pageId: string,
  rawHostname: string,
): Promise<StatusPage> {
  await requirePaidPlan(organizationId, "Status page custom domains");
  const cfg = requireConfig();
  const hostname = normalizeCustomHostname(rawHostname);

  const existing = await getStatusPageWire(organizationId, pageId);
  if (!existing) throw new StatusPageInputError("Status page not found", 404);
  if (existing.customHostname) {
    throw new StatusPageInputError(
      "This page already has a custom domain. Remove it before attaching another.",
    );
  }

  // Unique across orgs — surface a clean 400 instead of a unique-index 500.
  const [taken] = await db
    .select({ id: statusPages.id })
    .from(statusPages)
    .where(and(eq(statusPages.customHostname, hostname), ne(statusPages.id, pageId)))
    .limit(1);
  if (taken) {
    throw new StatusPageInputError("That hostname is already used by another status page");
  }

  const ch = await createCfHostname(cfg, hostname);
  const mapped = mapCfStatus(ch);
  const verification = verificationFrom(cfg, ch);

  // Persist identifiers before activating the vanity host in KV so a crash
  // between these steps still leaves detach/delete enough state to revoke.
  // Only fill an empty slot — a concurrent attach may have already won.
  let recorded: boolean;
  try {
    recorded = await persistHostnameRecoveryIfUnset(pageId, {
      customHostname: hostname,
      customHostnameStatus: mapped.status,
      cloudflareCustomHostnameId: ch.id,
      customHostnameError: mapped.error,
      customHostnameVerification: verification,
    });
  } catch (err) {
    const isUnique =
      err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505";
    // Never published to KV — only the Cloudflare hostname needs teardown.
    try {
      await deleteCfHostname(cfg, ch.id);
    } catch (cleanupErr) {
      const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      if (isUnique) {
        throw new StatusPageInputError(
          `That hostname is already used by another status page, and cleanup of ` +
            `Cloudflare custom hostname ${ch.id} (${hostname}) failed: ${cleanupMsg}. ` +
            `Manual revocation may be required.`,
        );
      }
      throw new StatusPageInputError(
        `Failed to record custom hostname, and cleanup of Cloudflare custom hostname ` +
          `${ch.id} (${hostname}) also failed. Manual revocation may be required. ` +
          `Cleanup error: ${cleanupMsg}.`,
      );
    }
    if (isUnique) {
      throw new StatusPageInputError("That hostname is already used by another status page");
    }
    throw err;
  }
  if (!recorded) {
    try {
      await deleteCfHostname(cfg, ch.id);
    } catch (cleanupErr) {
      const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      throw new StatusPageInputError(
        `This page already has a custom domain, and cleanup of Cloudflare custom hostname ` +
          `${ch.id} (${hostname}) failed: ${cleanupMsg}. Manual revocation may be required.`,
      );
    }
    throw new StatusPageInputError(
      "This page already has a custom domain. Remove it before attaching another.",
    );
  }

  try {
    // Publish under FOR UPDATE with the current slug so a concurrent rotation
    // cannot leave KV mapped to a retired public URL.
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          slug: statusPages.slug,
          cloudflareCustomHostnameId: statusPages.cloudflareCustomHostnameId,
        })
        .from(statusPages)
        .where(eq(statusPages.id, pageId))
        .limit(1)
        .for("update");
      if (!locked || locked.cloudflareCustomHostnameId !== ch.id) {
        throw new StatusPageInputError(
          "Custom hostname attach was interrupted; try attaching again.",
        );
      }
      await kvPut(cfg, hostname, locked.slug);
    });
  } catch (err) {
    if (err instanceof StatusPageInputError && /interrupted/i.test(err.message)) {
      await removeCustomHostnameInfra(hostname, ch.id).catch(() => undefined);
      throw err;
    }
    // Local identifiers exist — tear down external resources, then clear only
    // our row (matched by Cloudflare id) so a concurrent attach is preserved.
    try {
      await removeCustomHostnameInfra(hostname, ch.id);
      await db
        .update(statusPages)
        .set({
          customHostname: null,
          customHostnameStatus: "none",
          cloudflareCustomHostnameId: null,
          customHostnameError: null,
          customHostnameVerification: null,
          updatedAt: new Date(),
        })
        .where(and(eq(statusPages.id, pageId), eq(statusPages.cloudflareCustomHostnameId, ch.id)));
    } catch (cleanupErr) {
      const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      await db
        .update(statusPages)
        .set({
          customHostnameStatus: "error",
          customHostnameError: cleanupMsg,
          updatedAt: new Date(),
        })
        .where(and(eq(statusPages.id, pageId), eq(statusPages.cloudflareCustomHostnameId, ch.id)))
        .catch(() => undefined);
      throw new StatusPageInputError(
        `Failed to publish hostname mapping; Cloudflare custom hostname ${ch.id} (${hostname}) ` +
          `could not be fully cleaned up and remains recorded for retry. ` +
          `Cleanup error: ${cleanupMsg}.`,
      );
    }
    throw err;
  }

  return (await getStatusPageWire(organizationId, pageId))!;
}

export async function refreshCustomHostname(
  organizationId: string,
  pageId: string,
): Promise<StatusPage> {
  const cfg = requireConfig();

  // Serialize against slug rotation: read hostname + current slug under
  // FOR UPDATE, refresh Cloudflare state, then KV-put that same slug before
  // releasing so we cannot resurrect a retired public URL.
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        customHostname: statusPages.customHostname,
        cloudflareCustomHostnameId: statusPages.cloudflareCustomHostnameId,
        slug: statusPages.slug,
      })
      .from(statusPages)
      .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, pageId)))
      .limit(1)
      .for("update");
    if (!row) throw new StatusPageInputError("Status page not found", 404);
    if (!row.customHostname) {
      throw new StatusPageInputError("This page has no custom domain to refresh");
    }
    if (!row.cloudflareCustomHostnameId) {
      throw new StatusPageInputError(
        "Custom domain is missing Cloudflare state — detach and re-attach",
      );
    }

    const ch = await getCfHostname(cfg, row.cloudflareCustomHostnameId);
    const mapped = mapCfStatus(ch);
    const verification = verificationFrom(cfg, ch);

    await kvPut(cfg, row.customHostname, row.slug);

    const status =
      ch.status === "deleted" || ch.status === "moved" ? ("error" as const) : mapped.status;
    const error =
      ch.status === "deleted" || ch.status === "moved"
        ? (mapped.error ?? `Cloudflare status: ${ch.status}`)
        : mapped.error;

    await tx
      .update(statusPages)
      .set({
        customHostname: row.customHostname,
        customHostnameStatus: status,
        cloudflareCustomHostnameId: row.cloudflareCustomHostnameId,
        customHostnameError: error,
        customHostnameVerification: verification,
        updatedAt: new Date(),
      })
      .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, pageId)));
  });

  return (await getStatusPageWire(organizationId, pageId))!;
}

export async function detachCustomHostname(
  organizationId: string,
  pageId: string,
): Promise<StatusPage> {
  // Hold FOR UPDATE across Cloudflare/KV teardown and the local clear so a
  // concurrent refresh cannot republish the mapping after we delete it.
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        customHostname: statusPages.customHostname,
        customHostnameStatus: statusPages.customHostnameStatus,
        cloudflareCustomHostnameId: statusPages.cloudflareCustomHostnameId,
      })
      .from(statusPages)
      .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, pageId)))
      .limit(1)
      .for("update");
    if (!row) throw new StatusPageInputError("Status page not found", 404);
    if (!row.customHostname && row.customHostnameStatus === "none") {
      throw new StatusPageInputError("This page has no custom domain", 404);
    }

    await removeCustomHostnameInfra(row.customHostname, row.cloudflareCustomHostnameId);

    await tx
      .update(statusPages)
      .set({
        customHostname: null,
        customHostnameStatus: "none",
        cloudflareCustomHostnameId: null,
        customHostnameError: null,
        customHostnameVerification: null,
        updatedAt: new Date(),
      })
      .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, pageId)));
  });

  return (await getStatusPageWire(organizationId, pageId))!;
}
