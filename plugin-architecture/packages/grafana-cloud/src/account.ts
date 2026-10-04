import { CostSetupError } from "@infrawrench/plugin-base";
import type { GrafanaContext } from "./api.js";
import { cloudFetch, decodeCloudToken, statusOf } from "./api.js";
import type { GcOrg, GcStack } from "./types.js";

/**
 * Org discovery and the short-lived caches every lister shares.
 *
 * The Cloud API has no "who am I": every org-scoped route wants the org slug
 * (or numeric id) in the path. The token carries the org id, so the slug is
 * resolved from that with `GET /api/orgs/{id}` and nobody has to type it;
 * the optional `orgSlug` credential is the fallback for a token whose format
 * ever stops decoding.
 *
 * Stacks are read by nearly every lister (stack-level resources fan out over
 * them, cost maps stack ids to slugs), and the access policy routes are
 * rate-limited to 600 requests an hour per org, so both are cached in-process
 * for a short while, keyed by the token.
 */

const ORG_TTL_MS = 30 * 60_000;
const STACKS_TTL_MS = 60_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

const orgCache = new Map<string, Cached<GcOrg>>();
const stackCache = new Map<string, Cached<GcStack[]>>();

function cached<T>(
  map: Map<string, Cached<T>>,
  key: string,
  ttl: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = load();
  map.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (map.get(key)?.value === value) map.delete(key);
  });
  return value;
}

/** Drop the cached stack list, after a create, edit or delete. */
export function invalidateStacks(ctx: GrafanaContext): void {
  stackCache.delete(ctx.token);
}

export function orgKeyFor(ctx: GrafanaContext, orgSlug: string): string {
  return orgSlug.trim() || decodeCloudToken(ctx.token).orgId || "";
}

/**
 * The org this token belongs to. Throws a {@link CostSetupError} (which every
 * surface renders as a fix-it message) when neither the token nor the
 * credential names one.
 */
export function resolveOrg(ctx: GrafanaContext, orgSlug: string): Promise<GcOrg> {
  const key = orgKeyFor(ctx, orgSlug);
  if (!key) {
    return Promise.reject(
      new CostSetupError(
        "Could not tell which Grafana Cloud organization this token belongs to. Enter the organization slug on the account: it is the part after grafana.com/orgs/ in the address of your Grafana Cloud portal.",
      ),
    );
  }
  return cached(orgCache, `${ctx.token}|${key}`, ORG_TTL_MS, async () => {
    try {
      return await cloudFetch<GcOrg>(ctx, `/orgs/${encodeURIComponent(key)}`);
    } catch (err) {
      // Without `orgs:read` the slug still works for every other route.
      if (statusOf(err) === 403 && orgSlug.trim()) return { slug: orgSlug.trim() };
      throw err;
    }
  });
}

export async function orgSlugOf(ctx: GrafanaContext, orgSlug: string): Promise<string> {
  const org = await resolveOrg(ctx, orgSlug);
  const slug = org.slug ?? orgSlug.trim();
  if (!slug) throw new Error("Grafana Cloud plugin: the organization has no slug");
  return slug;
}

/** Every stack in the org (`GET /api/orgs/{slug}/instances`). */
export function listStacks(ctx: GrafanaContext, orgSlug: string): Promise<GcStack[]> {
  return cached(stackCache, ctx.token, STACKS_TTL_MS, async () => {
    const slug = await orgSlugOf(ctx, orgSlug);
    const res = await cloudFetch<{ items?: GcStack[] }>(
      ctx,
      `/orgs/${encodeURIComponent(slug)}/instances`,
    );
    return res.items ?? [];
  });
}

/**
 * Regions whose access policies are worth listing. Policies live in a region
 * and the list route requires one; the token's own region plus every region
 * the org has a stack in covers every policy anyone could have made for this
 * org's stacks.
 */
export async function policyRegions(ctx: GrafanaContext, orgSlug: string): Promise<string[]> {
  const out = new Set<string>();
  const own = decodeCloudToken(ctx.token).region;
  if (own) out.add(own);
  const stacks = await listStacks(ctx, orgSlug).catch(() => [] as GcStack[]);
  for (const s of stacks) if (s.regionSlug) out.add(s.regionSlug);
  return [...out].sort();
}

/** Clears every cache. Tests only. */
export function resetCachesForTests(): void {
  orgCache.clear();
  stackCache.clear();
}
