/**
 * Scans and prices a directory on this machine the way the forge and the
 * gateway's pass do, read-only, with instance list prices from the public
 * route (`/api/v1/instance-pricing/query`, the apps' own key) and no account.
 * Skipped unless `LOCAL_ESTIMATE_DIR` is set: a way to check estimates
 * against a real configuration, not a test of this repository.
 *
 *   LOCAL_ESTIMATE_DIR=/path/to/infra LOCAL_ESTIMATE_OUT=/tmp/estimate.json \
 *     pnpm --filter @infrawrench/server-core exec vitest run local-estimate
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { queryInstancePricing } from "@infrawrench/client-core";
import {
  SNAPSHOT_LIMITS,
  type TerraformSnapshotFile,
  isSkippedDirectory,
  isTerraformScanFile,
  scanTerraformSnapshot,
  summarizeScan,
} from "@infrawrench/git-terraform";

vi.mock("../../db/client.js", () => ({ db: {} }));

const top = process.env["LOCAL_ESTIMATE_DIR"];
const API = process.env["LOCAL_ESTIMATE_API"] ?? "https://app.infrawrench.com";

it.skipIf(!top)(
  "scans and prices a directory on this machine",
  async () => {
    const { priceConfiguration } = await import("../config-cost");
    const files: TerraformSnapshotFile[] = [];
    const skip = new Set((process.env["LOCAL_ESTIMATE_SKIP"] ?? "").split(",").filter(Boolean));
    const walk = (directory: string) => {
      for (const name of readdirSync(directory).sort()) {
        const full = join(directory, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (!isSkippedDirectory(name)) walk(full);
        } else if (isTerraformScanFile(name) && !skip.has(name)) {
          files.push({
            path: relative(top!, full),
            size: stat.size,
            text: stat.size > SNAPSHOT_LIMITS.maxFileBytes ? null : readFileSync(full, "utf8"),
          });
        }
      }
    };
    walk(top!);
    const scan = await scanTerraformSnapshot({ files, truncated: false });
    const estimates: Record<string, unknown> = {};
    for (const root of scan.roots) {
      estimates[root.directory.path] = (
        await priceConfiguration(null, root.pricing, {
          capabilities: {
            capabilityFor: () => undefined,
            typeMap: { byTerraformType: new Map(), byResourceType: new Map(), underivable: [] },
          },
          estimate: async () => null,
          pricing: { query: (sql, maxRows) => queryInstancePricing(API, sql, maxRows) },
          accounts: [],
          pluginName: (pluginId) => pluginId,
        })
      ).estimate;
    }
    const out = JSON.stringify(
      { files: files.map((file) => file.path), summary: summarizeScan(scan), estimates },
      null,
      2,
    );
    const target = process.env["LOCAL_ESTIMATE_OUT"];
    if (target) writeFileSync(target, out);
    else console.log(out);
    expect(scan.roots.length).toBeGreaterThanOrEqual(0);
  },
  120_000,
);
