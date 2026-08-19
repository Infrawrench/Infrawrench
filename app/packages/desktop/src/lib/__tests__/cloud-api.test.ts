import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("../invoke", () => ({ invoke: vi.fn() }));

const libDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (module: string) => readFileSync(join(libDir, `${module}.ts`), "utf8");

/** Every local module reachable from the barrel, the barrel included. */
function barrelGraph(): string[] {
  const seen = new Set<string>();
  const queue = ["cloud-api"];
  while (queue.length > 0) {
    const module = queue.shift()!;
    if (seen.has(module)) continue;
    seen.add(module);
    for (const match of read(module).matchAll(/(?:from|export \* from)\s+"\.\/([\w-]+)"/g)) {
      const next = match[1];
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen];
}

describe("cloud-api barrel", () => {
  it("re-exports the focused cloud modules", async () => {
    const api = await import("../cloud-api");
    // A representative export from each split module.
    expect(typeof api.getCloudAuthStatus).toBe("function"); // cloud-auth
    expect(typeof api.listCloudAccounts).toBe("function"); // cloud-accounts
    expect(typeof api.getCloudResourceDetail).toBe("function"); // cloud-resources
  });

  /**
   * These modules are `invoke()` wrappers over IPC. Nothing in them renders,
   * so nothing in them should reach for the `@infrawrench/ui` root barrel: one
   * value import from it drags the whole component library into every module
   * graph that touches `cloud-api`. That is what made the test above take four
   * times as long as it needed to, and time out outright whenever `turbo test`
   * saturated the machine — a flake with a cause, not a slow machine.
   *
   * Types are free, being erased. A subpath is fine too, and is how
   * `cloud-workflows` reaches a real shared value: `@infrawrench/ui/workflows/
   * prompt-bridge` exists precisely so a leaf can be imported without the
   * barrel behind it. Add another rather than widening this rule.
   *
   * The graph is read from the barrel rather than listed here, so a module
   * added to `cloud-api.ts` is covered without anybody remembering to.
   */
  it("takes no value import from the @infrawrench/ui barrel", () => {
    // `[^;]*?` keeps each match inside one statement — without it the pattern
    // starts at an earlier import and runs across the file to a later,
    // perfectly legitimate `import type … from "@infrawrench/ui"`.
    const valueImport = /^import\s+(?!type\b)[^;]*?from\s+"@infrawrench\/ui";/gm;

    const offenders = barrelGraph().flatMap((module) =>
      [...read(module).matchAll(valueImport)].map(
        (match) => `${module}.ts: ${match[0].replace(/\s+/g, " ")}`,
      ),
    );

    expect(offenders).toEqual([]);
  });
});
