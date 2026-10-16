import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `cloud-data/palette.ts` restates client-core's object kinds (main is
 * CommonJS and cannot import the ESM package at runtime). A kind added to the
 * palette index but not here would be searchable on web and silently missing
 * from the desktop's palette. Read as source text: the module registers IPC
 * handlers on import.
 */
describe("desktop palette search kinds", () => {
  it("match client-core's SEARCH_OBJECT_KINDS", async () => {
    // Dynamic: electron/ compiles to CommonJS and client-core is ESM.
    const { SEARCH_OBJECT_KINDS } = await import("@infrawrench/client-core");
    const source = readFileSync(join(process.cwd(), "electron/cloud-data/palette.ts"), "utf8");
    const block = /PALETTE_REMOTE_KINDS = \[([\s\S]*?)\] as const;/.exec(source);
    if (!block?.[1]) throw new Error("PALETTE_REMOTE_KINDS not found");
    const kinds = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual([...SEARCH_OBJECT_KINDS]);
  });
});
