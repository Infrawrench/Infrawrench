import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The preload bridge is an allowlist: the renderer can only invoke channels
 * listed in `INVOKE_CHANNELS`. A handler registered in `cloud-data/` but
 * missing from that list fails only at runtime, in the one mode nobody runs
 * locally — the feature works on web and silently dies on desktop. This test
 * is the cheap guard.
 *
 * Source text, not imports: `preload.ts` and the handlers both pull in
 * `electron`, which has no meaningful shape outside a real Electron process.
 */
// `electron/` builds to CommonJS, so no `import.meta` — resolve from the
// package root, which is vitest's cwd.
const ELECTRON_DIR = join(process.cwd(), "electron");

function preloadChannels(): Set<string> {
  const source = readFileSync(join(ELECTRON_DIR, "preload.ts"), "utf8");
  const block = /const INVOKE_CHANNELS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!block?.[1]) throw new Error("Could not find INVOKE_CHANNELS in preload.ts");
  return new Set([...block[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1] as string));
}

function cloudDataHandlers(): Map<string, string> {
  const dir = join(ELECTRON_DIR, "cloud-data");
  const handlers = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const match of source.matchAll(/ipcMain\.handle\(\s*"([a-z0-9_]+)"/g)) {
      handlers.set(match[1] as string, file);
    }
  }
  return handlers;
}

describe("preload INVOKE_CHANNELS", () => {
  it("exposes every cloud-data ipcMain handler", () => {
    const exposed = preloadChannels();
    const missing = [...cloudDataHandlers()]
      .filter(([channel]) => !exposed.has(channel))
      .map(([channel, file]) => `${channel} (cloud-data/${file})`);
    expect(missing).toEqual([]);
  });

  it("covers the agents-mode channels", () => {
    const exposed = preloadChannels();
    for (const channel of [
      "cloud_agents_accounts",
      "cloud_agents_get_settings",
      "cloud_agents_save_settings",
      "cloud_agents_list_sessions",
      "cloud_agents_create_session",
      "cloud_agents_open_session",
      "cloud_agents_reconcile_session",
      "cloud_agents_delete_session",
    ]) {
      expect(exposed).toContain(channel);
    }
  });
});
