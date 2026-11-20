// The runtime tests run the built package (the CJS entries, configSync's
// worker, `@infrawrench/infraenv/config` in a child process), so build it
// first when dist/ is missing or older than what it is built from. No
// declarations: tsdown's declaration bundler has no WebAssembly build, and
// the tests only run JavaScript.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;

function newest(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = 0;
  for (const entry of readdirSync(path)) {
    if (entry === "__tests__") continue;
    latest = Math.max(latest, newest(join(path, entry)));
  }
  return latest;
}

function builtAt(): number {
  try {
    return Math.min(
      ...["cli.mjs", "index.cjs", "config.mjs", "config.cjs", "load-worker.mjs"].map(
        (file) => statSync(join(root, "dist", file)).mtimeMs,
      ),
    );
  } catch {
    return 0;
  }
}

export default async function setup(): Promise<void> {
  const sources = Math.max(
    newest(join(root, "src")),
    newest(join(root, "tsdown.config.ts")),
    newest(join(root, "package.json")),
  );
  if (builtAt() >= sources) return;
  const { build } = await import("tsdown");
  await build({ cwd: root, dts: false, logLevel: "warn" });
}
