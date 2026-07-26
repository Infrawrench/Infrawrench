#!/usr/bin/env tsx
/**
 * Generate the client SDKs from the OpenAPI document.
 *
 * By default this reads the checked-in `openapi.json`, which is the artifact
 * the spec workflow already treats as the source of truth for generated
 * clients — so this command is fast and needs no plugin registry or database.
 * Pass `--rebuild` to build the spec from the live plugin registry first
 * (the same thing `generate:openapi` does, minus writing the file).
 *
 * Output goes to `<repo>/sdk/<target>/`, which is gitignored and outside the
 * pnpm workspace. Nothing regenerates unless the API version changed — see
 * `./sdk/generate.ts` for the exact staleness rules, and pass `--force` to
 * override them.
 *
 * Usage:
 *   pnpm --filter @infrawrench/web generate:sdk
 *   pnpm --filter @infrawrench/web generate:sdk -- --force
 *   pnpm --filter @infrawrench/web generate:sdk -- --target typescript
 *   pnpm --filter @infrawrench/web generate:sdk -- --rebuild
 *   pnpm --filter @infrawrench/web generate:sdk -- --list
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateSdks } from "./sdk/generate";
import { SDK_TARGETS } from "./sdk/targets/index";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, "..", "openapi.json");

const { values } = parseArgs({
  options: {
    force: { type: "boolean", default: false },
    rebuild: { type: "boolean", default: false },
    target: { type: "string", multiple: true, default: [] },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(
    [
      "Usage: generate:sdk [options]",
      "",
      "  --target <id>   Generate only this target (repeatable). Default: all.",
      "  --force         Regenerate even if the API version is unchanged.",
      "  --rebuild       Build the spec from the live plugin registry first.",
      "  --list          List the registered targets and exit.",
      "  -h, --help      Show this message.",
    ].join("\n"),
  );
  process.exit(0);
}

if (values.list) {
  for (const target of SDK_TARGETS) {
    console.log(`${target.id.padEnd(12)} ${target.displayName} → ${target.packageName}`);
  }
  process.exit(0);
}

async function loadDocument(): Promise<object> {
  if (!values.rebuild) {
    try {
      return JSON.parse(await readFile(specPath, "utf8")) as object;
    } catch (error) {
      throw new Error(
        `Could not read ${specPath} (${String(error)}).\n` +
          "Run `pnpm --filter @infrawrench/web generate:openapi` first, or pass --rebuild.",
      );
    }
  }
  // Imported lazily: this pulls in the plugin registry, which the default
  // read-from-disk path has no reason to pay for.
  const [{ buildOpenApiDocument }, { SPEC_SERVERS }] = await Promise.all([
    import("../src/api/openapi/index"),
    import("./spec-servers"),
  ]);
  return buildOpenApiDocument({ servers: [...SPEC_SERVERS] });
}

const { apiVersion, results } = await generateSdks({
  document: await loadDocument(),
  ...(values.target.length > 0 ? { targets: values.target } : {}),
  force: values.force,
  log: (message) => console.log(message),
});

const regenerated = results.filter((result) => result.regenerated);
if (regenerated.length === 0) {
  console.log(`Nothing to do — every SDK already matches API v${apiVersion}.`);
} else {
  for (const result of regenerated) {
    console.log(`  ${result.packageName}@${result.apiVersion} → ${result.outDir}`);
  }
}
