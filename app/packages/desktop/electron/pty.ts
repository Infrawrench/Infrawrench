import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolveBinaryPath(command: string): string {
  const binaryPath = cp.execFileSync("/usr/bin/which", [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!binaryPath) throw new Error(`Command not found: ${command}`);
  return binaryPath;
}

export function buildPtyEnv(cols: number, rows: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env["TERM"] = "xterm-256color";
  env["COLUMNS"] = String(cols);
  env["LINES"] = String(rows);
  return env;
}

export function ensureNodePtySpawnHelperExecutable(): void {
  if (process.platform !== "darwin") return;

  const packageJsonPath = require.resolve("node-pty/package.json");
  const helperPath = path.join(
    path.dirname(packageJsonPath),
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );

  try {
    fs.accessSync(helperPath, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(helperPath, 0o755);
    } catch (error) {
      throw new Error(
        `node-pty spawn-helper is not executable at ${helperPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
