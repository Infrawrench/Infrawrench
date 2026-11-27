/**
 * Scans a directory on this machine the way the forge scans a repository,
 * read-only, and writes what it found to `LOCAL_SCAN_OUT` (or prints it).
 * Skipped unless `LOCAL_SCAN_DIR` is set: a way to check the scanner against
 * a real configuration, not a test of anything in this repository.
 *
 *   LOCAL_SCAN_DIR=/path/to/infra pnpm --filter @infrawrench/git-terraform test local-scan
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import {
  SNAPSHOT_LIMITS,
  type TerraformSnapshotFile,
  isSkippedDirectory,
  isTerraformScanFile,
  scanTerraformSnapshot,
} from "../src/index.js";

const top = process.env["LOCAL_SCAN_DIR"];

it.skipIf(!top)("scans a directory on this machine", async () => {
  const files: TerraformSnapshotFile[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!isSkippedDirectory(name)) walk(full);
      } else if (isTerraformScanFile(name)) {
        files.push({
          path: relative(top!, full),
          size: stat.size,
          text: stat.size > SNAPSHOT_LIMITS.maxFileBytes ? null : readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(top!);
  const started = performance.now();
  const scan = await scanTerraformSnapshot({ files, truncated: false });
  const ms = Math.round(performance.now() - started);
  const out = JSON.stringify({ ms, files: files.map((file) => file.path), ...scan }, null, 2);
  const target = process.env["LOCAL_SCAN_OUT"];
  if (target) writeFileSync(target, out);
  else console.log(out);
  expect(scan.directories.length).toBeGreaterThanOrEqual(0);
});
