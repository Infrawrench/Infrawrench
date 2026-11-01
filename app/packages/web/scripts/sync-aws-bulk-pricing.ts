/**
 * Sync the AWS bulk pricing data in Workers KV from the bundles in R2; see
 * `src/aws-bulk-pricing/sync.ts`. Run hourly by
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
 *
 * R2 is read with the AWS CLI (preinstalled on GitHub runners), as the
 * instances-bundler publishes with it.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { KvRest } from "../src/aws-bulk-pricing/kv-rest";
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

function warehouse(): ClickHouseWarehouse | undefined {
  const url = process.env.PRICING_WAREHOUSE_URL;
  const token = process.env.PRICING_WAREHOUSE_TOKEN;
  if (!url || !token) {
    console.log("warehouse: PRICING_WAREHOUSE_URL / PRICING_WAREHOUSE_TOKEN not set, skipping");
    return undefined;
  }
  return new ClickHouseWarehouse(new ClickHouseHttp({ url, token }));
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

let loaded = false;
try {
  const results = await syncAwsBulkPricing(r2Bucket(), kv, console.log, warehouse());
  loaded = results.some((r) => r.warehouseRows !== undefined);
} catch (error) {
  // Some platforms may have loaded before another failed.
  loaded = true;
  throw error;
} finally {
  if (loaded) await notifyInstances();
}
