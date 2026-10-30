import { env } from "cloudflare:workers";
import type { InstanceFile } from "./decode";

/**
 * Reads from the `AWS_BULK_PRICING` namespace. The keys and value format are
 * defined by `app/packages/web/src/aws-bulk-pricing/format.ts` (the sync writes
 * them); this side only reads.
 */

/** What `platform:<platform>` holds; only the fields this site uses. */
export interface PlatformState {
  platform: string;
  /** Unix seconds of every price list version the bundle was built from. */
  snapshots: number[];
  /** When the sync finished, in Unix milliseconds. */
  synced: number;
  /** Instance name to a hash of its value. */
  instances: Record<string, string>;
}

/** What `catalog` holds: every platform's instance names in one small value (`Catalog` in format.ts). */
export interface Catalog {
  synced: number;
  platforms: Record<string, { version: string; asOf: number | null; instances: string[] }>;
}

/** How long a data centre may serve a KV read from its own cache. The sync runs every 30 minutes. */
const CACHE_TTL = 300;

export async function readPlatform(platform: string): Promise<PlatformState | null> {
  return env.AWS_BULK_PRICING.get<PlatformState>(`platform:${platform}`, {
    type: "json",
    cacheTtl: CACHE_TTL,
  });
}

/** One instance, in the bundle encoding. Stored gzipped. */
export async function readInstance(platform: string, name: string): Promise<InstanceFile | null> {
  const stream = await env.AWS_BULK_PRICING.get(`instance:${platform}:${name}`, {
    type: "stream",
    cacheTtl: CACHE_TTL,
  });
  if (!stream) return null;
  const text = await new Response(stream.pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(text) as InstanceFile;
}

/** Every platform's instance names, or null until the sync has written it. */
export async function readCatalog(): Promise<Catalog | null> {
  return env.AWS_BULK_PRICING.get<Catalog>("catalog", { type: "json", cacheTtl: CACHE_TTL });
}
