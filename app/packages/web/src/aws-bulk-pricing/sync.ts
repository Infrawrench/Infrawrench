/**
 * Bring the AWS bulk pricing data in Workers KV up to date with the bundles in
 * R2. Runs on a GitHub runner (`scripts/sync-aws-bulk-pricing.ts`), not in a
 * Worker: an EC2 bundle is over 200 MB of JSON.
 *
 * Each platform's `<prefix>latest` is compared with the version last synced.
 * When it has moved, the new bundle is streamed through xz and parsed one
 * instance at a time ({@link scanBundle}), and only instances whose value
 * changed are written. The platform's state goes last, so a sync that dies part
 * way is redone in full by the next run.
 */

import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
// CJS with no ESM entry; see services/iwappd-binaries.ts for why it is a default import.
import xzDecompressModule from "xz-decompress";

import { scanBundle } from "./bundle-stream";
import {
  CATALOG_KEY,
  PLATFORMS,
  bucketPrefix,
  catalogPlatform,
  instanceKey,
  platformKey,
  readTables,
  reduceInstance,
  type Catalog,
  type PlatformState,
  type Tables,
} from "./format";
import { BULK_MAX_BYTES, BULK_MAX_PAIRS, type KvPair } from "./kv-rest";

const { XzReadableStream } = xzDecompressModule;
const gzip = promisify(gzipCallback);

export interface BundleBucket {
  /** A small object's text, or null when the key is not there. */
  text(key: string): Promise<string | null>;
  /** An object's bytes; the stream errors if the key is not there. */
  stream(key: string): ReadableStream<Uint8Array>;
}

export interface PricingKv {
  getJson<T>(key: string): Promise<T | null>;
  putMany(pairs: KvPair[]): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
}

export interface SyncResult {
  platform: string;
  version: string;
  written: number;
  deleted: number;
}

/**
 * Sync every platform, one at a time. One failing does not stop the rest, but
 * the run still fails at the end.
 */
export async function syncAwsBulkPricing(
  bucket: BundleBucket,
  kv: PricingKv,
  log: (line: string) => void = console.log,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const failures: unknown[] = [];
  // Each platform's state as it stands after this run, for the catalog.
  const states: Record<string, PlatformState> = {};
  for (const platform of Object.keys(PLATFORMS)) {
    let previous: PlatformState | null = null;
    try {
      previous = await kv.getJson<PlatformState>(platformKey(platform));
      if (previous) states[platform] = previous;
      const result = await syncPlatform(platform, bucket, kv, previous);
      if (!result) {
        log(`${platform}: no new bundle`);
        continue;
      }
      const current = await kv.getJson<PlatformState>(platformKey(platform));
      if (current) states[platform] = current;
      results.push(result);
      log(
        `${platform}: now ${result.version} (${result.written} written, ${result.deleted} deleted)`,
      );
    } catch (error) {
      log(`${platform}: failed: ${error instanceof Error ? error.message : String(error)}`);
      failures.push(error);
    }
  }
  // Even when a platform failed: the others' names are current, and a failed
  // platform keeps the state (and so the names) it had.
  await writeCatalog(kv, states, log);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} platform(s) failed to sync`);
  }
  return results;
}

/** Rebuild `catalog` from the platform states; written only when it changed. */
async function writeCatalog(
  kv: PricingKv,
  states: Record<string, PlatformState>,
  log: (line: string) => void,
): Promise<void> {
  const platforms = Object.fromEntries(
    Object.entries(states).map(([platform, state]) => [platform, catalogPlatform(state)]),
  );
  const previous = await kv.getJson<Catalog>(CATALOG_KEY);
  if (previous && JSON.stringify(previous.platforms) === JSON.stringify(platforms)) return;
  const catalog: Catalog = { synced: Date.now(), platforms };
  await kv.putMany([
    { key: CATALOG_KEY, value: new TextEncoder().encode(JSON.stringify(catalog)) },
  ]);
  log(`catalog: ${Object.keys(platforms).length} platform(s)`);
}

/** Sync one platform; null when its bundle has not moved, or there is none yet. */
export async function syncPlatform(
  platform: string,
  bucket: BundleBucket,
  kv: PricingKv,
  previous: PlatformState | null,
): Promise<SyncResult | null> {
  const prefix = bucketPrefix(platform);
  const latest = await bucket.text(`${prefix}latest`);
  if (latest === null) return null;
  const version = latest.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new Error(`${prefix}latest holds ${JSON.stringify(version)}, which is not a version`);
  }
  if (previous?.version === version) return null;

  const bundle = `${prefix}bundle-${version}.json.xz`;
  const before = previous?.instances ?? {};
  const hashes: Record<string, string> = {};
  const batch = new Batch(kv);
  const raw: Record<string, unknown> = {};
  let tables: Tables | null = null;

  const json = new XzReadableStream(bucket.stream(bundle)) as ReadableStream<Uint8Array>;
  for await (const event of scanBundle(chunks(json))) {
    if (event.kind === "table") {
      if (tables) throw new Error(`${bundle} has "${event.key}" after its instances`);
      raw[event.key] = event.value;
      continue;
    }
    tables ??= readTables(raw, platform);
    const value = JSON.stringify(reduceInstance(tables, platform, event.name, event.value));
    const hash = createHash("sha256").update(value).digest("hex");
    hashes[event.name] = hash;
    if (before[event.name] === hash) continue;
    await batch.put({
      key: instanceKey(platform, event.name),
      value: await gzip(value),
      metadata: { hash },
    });
  }
  tables ??= readTables(raw, platform);
  await batch.flush();

  // A bundle keeps deleted instances (with `deletedAt` set), so this only
  // happens when a reseed drops one.
  const gone = Object.keys(before).filter((name) => !(name in hashes));
  await kv.deleteMany(gone.map((name) => instanceKey(platform, name)));

  const state: PlatformState = {
    platform,
    offer: tables.offer,
    variant_keys: tables.variantKeys,
    version,
    bundle,
    snapshots: tables.snapshots,
    synced: Date.now(),
    instances: hashes,
  };
  await kv.putMany([
    { key: platformKey(platform), value: new TextEncoder().encode(JSON.stringify(state)) },
  ]);
  return { platform, version, written: batch.written, deleted: gone.length };
}

/** Collects pairs into bulk writes as large as the API takes. */
class Batch {
  private pairs: KvPair[] = [];
  private bytes = 0;
  written = 0;

  constructor(private readonly kv: PricingKv) {}

  async put(pair: KvPair): Promise<void> {
    if (this.pairs.length >= BULK_MAX_PAIRS || this.bytes + pair.value.length > BULK_MAX_BYTES) {
      await this.flush();
    }
    this.pairs.push(pair);
    this.bytes += pair.value.length;
    this.written++;
  }

  async flush(): Promise<void> {
    const pairs = this.pairs;
    this.pairs = [];
    this.bytes = 0;
    await this.kv.putMany(pairs);
  }
}

async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
