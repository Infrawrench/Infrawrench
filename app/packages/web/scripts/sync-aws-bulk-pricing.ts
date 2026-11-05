/**
 * Sync the bulk pricing data (AWS, RunPod, Alibaba Cloud, Azure, Google Cloud) in Workers KV from the bundles in R2; see
 * `src/aws-bulk-pricing/sync.ts`. With a warehouse, also merge AWS's public
 * status page history into its `service_events` table
 * (`src/aws-bulk-pricing/service-events.ts`). Run twice an hour by
 * `.github/workflows/aws-bulk-pricing-sync.yml`.
 *
 *   pnpm --filter @infrawrench/web sync:aws-bulk-pricing
 *
 * Environment:
 *   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   R2 S3 API credentials (read)
 *   INSTANCES_BUNDLES_BUCKET                              defaults to instances-bundles
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN           a token that can edit Workers KV
 *   AWS_BULK_PRICING_KV_NAMESPACE_ID                      the namespace the web Worker binds
 *   PRICING_WAREHOUSE_URL, PRICING_WAREHOUSE_TOKEN        optional: the AWS pricing warehouse
 *                                                         (ClickHouse HTTP URL, a write token);
 *                                                         without them only KV is synced
 *   INSTANCES_NOTIFY_URL, INSTANCES_NOTIFY_SECRET         optional: told after a warehouse load,
 *                                                         so instances.infrawrench.com can email
 *                                                         subscribers whose results changed
 *   SOCIAL_POST                                           1 to post notable changes (with a
 *                                                         warehouse); otherwise they are only
 *                                                         logged and written to the job summary
 *   BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD              optional: the Bluesky account to post as
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,              optional: the X app and the account's
 *   X_ACCESS_TOKEN_SECRET                                 access token to post as
 *
 * R2 is read with the AWS CLI (preinstalled on GitHub runners), as the
 * instances-bundler publishes with it.
 */

import { execFile, spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";

import { KvRest } from "../src/aws-bulk-pricing/kv-rest";
import { syncServiceEvents } from "../src/aws-bulk-pricing/service-events";
import {
  changesSince,
  cursors,
  plan,
  postBluesky,
  postX,
  type Change,
} from "../src/aws-bulk-pricing/social";
import { syncAwsBulkPricing, type BundleBucket } from "../src/aws-bulk-pricing/sync";
import { ClickHouseHttp, ClickHouseWarehouse } from "../src/aws-bulk-pricing/warehouse";

const run = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function r2Bucket(): BundleBucket {
  const bucket = process.env.INSTANCES_BUNDLES_BUCKET || "instances-bundles";
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: required("R2_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY: required("R2_SECRET_ACCESS_KEY"),
    // Newer AWS CLIs send checksum headers R2 may not accept unless asked for.
    AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
  };
  const args = (key: string) => [
    "s3",
    "cp",
    `s3://${bucket}/${key}`,
    "-",
    "--endpoint-url",
    required("R2_ENDPOINT"),
    "--region",
    "auto",
    "--only-show-errors",
  ];

  return {
    async text(key) {
      try {
        const { stdout } = await run("aws", args(key), { env, maxBuffer: 1 << 20 });
        return stdout;
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        // Anything else (bad credentials, wrong bucket) must not read as "no bundle yet".
        if (/\b404\b|Not Found|NoSuchKey/.test(stderr)) return null;
        throw new Error(`reading s3://${bucket}/${key} failed: ${stderr.trim()}`);
      }
    },
    stream(key) {
      const child = spawn("aws", args(key), { env, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      return new ReadableStream<Uint8Array>({
        start(controller) {
          child.stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          child.on("error", (error) => controller.error(error));
          child.on("close", (code) => {
            if (code === 0) controller.close();
            else
              controller.error(new Error(`reading s3://${bucket}/${key} failed: ${stderr.trim()}`));
          });
        },
        cancel() {
          child.kill();
        },
      });
    },
  };
}

const kv = new KvRest({
  accountId: required("CLOUDFLARE_ACCOUNT_ID"),
  namespaceId: required("AWS_BULK_PRICING_KV_NAMESPACE_ID"),
  apiToken: required("CLOUDFLARE_API_TOKEN"),
});

function warehouse(): { ch: ClickHouseHttp; pricing: ClickHouseWarehouse } | undefined {
  const url = process.env.PRICING_WAREHOUSE_URL;
  const token = process.env.PRICING_WAREHOUSE_TOKEN;
  if (!url || !token) {
    console.log("warehouse: PRICING_WAREHOUSE_URL / PRICING_WAREHOUSE_TOKEN not set, skipping");
    return undefined;
  }
  const ch = new ClickHouseHttp({ url, token });
  return { ch, pricing: new ClickHouseWarehouse(ch) };
}

/** Tell the instances site the warehouse moved, so it can check email subscriptions. */
async function notifyInstances(): Promise<void> {
  const url = process.env.INSTANCES_NOTIFY_URL;
  const secret = process.env.INSTANCES_NOTIFY_SECRET;
  if (!url || !secret) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(120_000),
    });
    console.log(`notify: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (error) {
    // Subscribers are checked again after the next load; not worth failing the sync.
    console.log(`notify: failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Post what changed in the sources this run loaded (`src/aws-bulk-pricing/social.ts`).
 * Never fails the sync: a missed post is not worth a red run.
 */
async function postChanges(
  ch: ClickHouseHttp,
  before: Map<string, string>,
  sources: string[],
): Promise<void> {
  try {
    const changes: Change[] = [];
    for (const source of sources) {
      const since = before.get(source);
      if (!since) {
        console.log(`social: ${source}: no earlier load to compare with, skipping`);
        continue;
      }
      const found = await changesSince(ch, source, since);
      console.log(`social: ${source}: ${found.length} change(s) since ${since}`);
      changes.push(...found);
    }
    const posts = plan(changes);
    if (posts.length === 0) return;
    const live = process.env.SOCIAL_POST === "1";
    for (const post of posts)
      console.log(`social: ${live ? "posting" : "would post"}:\n${post.text}`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      await appendFile(
        summary,
        `## Social posts (${live ? "posted" : "dry run"})\n\n${posts.map((p) => `> ${p.text.replace(/\n/g, "\n> ")}`).join("\n\n")}\n\n`,
      );
    }
    if (!live) return;
    const { BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD } = process.env;
    if (BLUESKY_IDENTIFIER && BLUESKY_APP_PASSWORD) {
      await postBluesky(
        { identifier: BLUESKY_IDENTIFIER, password: BLUESKY_APP_PASSWORD },
        posts,
      ).catch((error: unknown) => console.log(`social: ${errorText(error)}`));
    }
    const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET } = process.env;
    if (X_API_KEY && X_API_SECRET && X_ACCESS_TOKEN && X_ACCESS_TOKEN_SECRET) {
      await postX(
        {
          apiKey: X_API_KEY,
          apiSecret: X_API_SECRET,
          accessToken: X_ACCESS_TOKEN,
          accessTokenSecret: X_ACCESS_TOKEN_SECRET,
        },
        posts,
      ).catch((error: unknown) => console.log(`social: ${errorText(error)}`));
    }
  } catch (error) {
    console.log(`social: failed: ${errorText(error)}`);
  }
}

const store = warehouse();
// Each source's newest price list before this run, so changes are only what the run brought.
let before: Map<string, string> | null = null;
if (store) {
  try {
    before = await cursors(store.ch);
  } catch (error) {
    console.log(`social: could not read sync state: ${errorText(error)}`);
  }
}
let loaded = false;
let failure: unknown = null;
try {
  const results = await syncAwsBulkPricing(r2Bucket(), kv, console.log, store?.pricing);
  loaded = results.some((r) => r.warehouseRows !== undefined);
  if (store && before) {
    const sources = results.filter((r) => r.warehouseRows !== undefined).map((r) => r.platform);
    if (sources.length > 0) await postChanges(store.ch, before, sources);
  }
} catch (error) {
  // Some platforms may have loaded before another failed.
  loaded = true;
  failure = error;
}
// AWS's public status page history, independent of the price lists: a failure
// of either still runs the other, and fails the run at the end.
if (store) {
  try {
    const { changed } = await syncServiceEvents(store.ch);
    if (changed > 0) loaded = true;
  } catch (error) {
    console.log(
      `service events: failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    failure ??= error;
  }
}
if (loaded) await notifyInstances();
if (failure) throw failure;
