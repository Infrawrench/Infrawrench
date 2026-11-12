import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = new URL("..", import.meta.url).pathname;

/*
 * esbuild's native binary has no WebAssembly build in the same package. Where Node itself is
 * WebAssembly (Infrawrench CI's runner) the bundle is made by `esbuild-wasm`, the same esbuild
 * compiled to WebAssembly, with the same API and output.
 */
const { build } =
  (process.platform as string) === "wasi" ? await import("esbuild-wasm") : await import("esbuild");

/** The `--banner:js` an image or a local build uses. */
function bannerIn(file: string): string {
  const text = readFileSync(join(here, file), "utf8");
  const match = /--banner:js=\\?"(.*?)\\?"/.exec(text);
  if (!match?.[1]) throw new Error(`${file} has no banner`);
  return match[1];
}

/**
 * A bundle that does not parse is an agent that exits on start, which no unit test of the
 * source can see: the banner and whatever a dependency imports share one module scope.
 */
describe("the agent's bundle", () => {
  it.each(["Dockerfile", "package.json"])("parses with the banner from %s", async (file) => {
    const dir = mkdtempSync(join(tmpdir(), "bastion-agent-bundle-"));
    try {
      const outfile = join(dir, "index.mjs");
      await build({
        entryPoints: [join(here, "src/index.ts")],
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        outfile,
        banner: { js: bannerIn(file) },
        logLevel: "silent",
      });
      expect(() =>
        execFileSync(process.execPath, ["--check", outfile], { stdio: "pipe" }),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
