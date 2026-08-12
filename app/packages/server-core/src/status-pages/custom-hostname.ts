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
import { and, eq, ne } from "drizzle-orm";
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

function mapCfStatus(ch: CfCustomHostname): {
  status: StatusPageCustomHostnameStatus;
  error: string | null;
} {
  const hostnameActive = ch.status === "active";
  const sslStatus = ch.ssl?.status ?? "";
  const sslActive = sslStatus === "active";
  const errors = [
    ...(ch.verification_errors ?? []),
    ...(ch.ssl?.validation_errors?.map((e) => e.message).filter(Boolean) as string[]),
  ].filter(Boolean);

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

async function readCfId(pageId: string): Promise<{
  hostname: string | null;
  cfId: string | null;
  slug: string;
} | null> {
  const [row] = await db
    .select({
      hostname: statusPages.customHostname,
      cfId: statusPages.cloudflareCustomHostnameId,
      slug: statusPages.slug,
    })
    .from(statusPages)
    .where(eq(statusPages.id, pageId))
    .limit(1);
  if (!row) return null;
  return { hostname: row.hostname, cfId: row.cfId, slug: row.slug };
}

/** Tear down CF + KV before a page row is deleted. */
export async function teardownCustomHostnameForPage(pageId: string): Promise<void> {
  const meta = await readCfId(pageId);
  if (!meta) return;
  await removeCustomHostnameInfra(meta.hostname, meta.cfId);
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

  try {
    await kvPut(cfg, hostname, existing.slug);
  } catch (err) {
    // Roll back the CF hostname so a retry isn't stuck with an orphan.
    await deleteCfHostname(cfg, ch.id).catch(() => undefined);
    throw err;
  }

  try {
    await persistHostnameFields(pageId, {
      customHostname: hostname,
      customHostnameStatus: mapped.status,
      cloudflareCustomHostnameId: ch.id,
      customHostnameError: mapped.error,
      customHostnameVerification: verification,
    });
  } catch (err) {
    const isUnique =
      err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505";
    try {
      await removeCustomHostnameInfra(hostname, ch.id);
    } catch (cleanupErr) {
      // Cleanup failed — keep CF/KV identifiers on the page (unless the
      // hostname is owned by another row) so detach can retry revocation.
      if (!isUnique) {
        try {
          await persistHostnameFields(pageId, {
            customHostname: hostname,
            customHostnameStatus: "error",
            cloudflareCustomHostnameId: ch.id,
            customHostnameError:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : "Failed to roll back custom hostname after attach",
            customHostnameVerification: verification,
          });
        } catch (persistErr) {
          // Last resort: surface the Cloudflare id in the error so ops can
          // revoke manually — swallowing here would leave an unrecoverable orphan.
          const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          const persistMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
          throw new StatusPageInputError(
            `Custom hostname attach left an orphan that could not be recorded for retry. ` +
              `Manually delete Cloudflare custom hostname ${ch.id} (${hostname}). ` +
              `Cleanup error: ${cleanupMsg}. Persist error: ${persistMsg}.`,
          );
        }
      }
      throw cleanupErr;
    }
    if (isUnique) {
      throw new StatusPageInputError("That hostname is already used by another status page");
    }
    throw err;
  }

  return (await getStatusPageWire(organizationId, pageId))!;
}

export async function refreshCustomHostname(
  organizationId: string,
  pageId: string,
): Promise<StatusPage> {
  const existing = await getStatusPageWire(organizationId, pageId);
  if (!existing) throw new StatusPageInputError("Status page not found", 404);
  if (!existing.customHostname) {
    throw new StatusPageInputError("This page has no custom domain to refresh");
  }

  const cfg = requireConfig();
  const meta = await readCfId(pageId);
  if (!meta?.cfId) {
    throw new StatusPageInputError(
      "Custom domain is missing Cloudflare state — detach and re-attach",
    );
  }

  const ch = await getCfHostname(cfg, meta.cfId);
  const mapped = mapCfStatus(ch);
  const verification = verificationFrom(cfg, ch);

  // Keep KV fresh in case a prior write failed.
  await kvPut(cfg, existing.customHostname, meta.slug);

  await persistHostnameFields(pageId, {
    customHostname: existing.customHostname,
    // verification_errors while still pending ("does not CNAME…") are expected
    // progress messages — keep pending_dns / pending_ssl, not error.
    customHostnameStatus: mapped.status,
    cloudflareCustomHostnameId: meta.cfId,
    customHostnameError: mapped.error,
    customHostnameVerification: verification,
  });

  // If Cloudflare reports a hard failure state, mark error.
  if (ch.status === "deleted" || ch.status === "moved") {
    await persistHostnameFields(pageId, {
      customHostname: existing.customHostname,
      customHostnameStatus: "error",
      cloudflareCustomHostnameId: meta.cfId,
      customHostnameError: mapped.error ?? `Cloudflare status: ${ch.status}`,
      customHostnameVerification: verification,
    });
  }

  return (await getStatusPageWire(organizationId, pageId))!;
}

export async function detachCustomHostname(
  organizationId: string,
  pageId: string,
): Promise<StatusPage> {
  const existing = await getStatusPageWire(organizationId, pageId);
  if (!existing) throw new StatusPageInputError("Status page not found", 404);
  if (!existing.customHostname && existing.customHostnameStatus === "none") {
    throw new StatusPageInputError("This page has no custom domain", 404);
  }

  const meta = await readCfId(pageId);
  await removeCustomHostnameInfra(meta?.hostname ?? existing.customHostname, meta?.cfId ?? null);

  await persistHostnameFields(pageId, {
    customHostname: null,
    customHostnameStatus: "none",
    cloudflareCustomHostnameId: null,
    customHostnameError: null,
    customHostnameVerification: null,
  });

  return (await getStatusPageWire(organizationId, pageId))!;
}
