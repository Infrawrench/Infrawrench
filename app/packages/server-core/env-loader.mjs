/**
 * Shared dev-time `.env` loader for every process that reads server config out
 * of `process.env` (web, poller, github-watcher). Preloaded with node's
 * `--import` before any application module runs, so `process.env` is populated
 * by the time `db/client.ts` reads `DATABASE_URL` at import time.
 *
 * The web package owns the canonical `.env` / `.env.local` (see
 * `app/packages/web/.env.example`), so that directory is always searched first;
 * the process's own cwd is searched second so a package can override a value
 * locally. Existing `process.env` entries always win — this never clobbers what
 * the shell or the container already set.
 *
 * Production does not use this: there the values come from the `infrawrench-env`
 * k8s secret (`app_env` in `infra/terraform/terraform.tfvars.example`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

for (const base of [webDir, process.cwd()]) {
  for (const name of [".env.local", ".env"]) {
    try {
      const content = readFileSync(resolve(base, name), "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        if (!(key in process.env)) process.env[key] = val;
      }
    } catch {
      /* file doesn't exist — skip */
    }
  }
}
