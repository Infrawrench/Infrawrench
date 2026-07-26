/**
 * The generator orchestrator: decide what's stale, then run the targets.
 *
 * ## Isolation
 *
 * Output lands in `<repo>/sdk/<target-id>/`, outside every `pnpm-workspace.yaml`
 * glob and gitignored. That is deliberate — the emitted package must not be a
 * workspace member, must not resolve `workspace:*` dependencies, and must not
 * be something anyone is tempted to hand-edit. Each run wipes its target's
 * directory and rebuilds it from scratch, so there is no such thing as a
 * partially-migrated SDK.
 *
 * ## When it regenerates
 *
 * The trigger is **the API version changing** — `info.version` in the spec,
 * which is also the version the emitted `package.json` carries. A stamp file
 * in each output directory records what it was built from.
 *
 * The stamp also records a hash of the published spec and a generator revision,
 * and a change in either regenerates too. That is a superset of what "the API
 * version changed" strictly asks for, and it is the safer default: shipping an
 * SDK that silently disagrees with the server because someone added a route
 * without bumping `info.version` is worse than an extra rebuild. The reason for
 * each rebuild is reported, so an unexpected `spec-changed` is visible rather
 * than silent.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toPublicDocument } from "../../src/api/openapi/public-spec";
import { buildSdkIr } from "./ir";
import { SDK_TARGETS, findTarget } from "./targets/index";
import type { SdkTarget } from "./target";

/** Bump when the emitter changes shape, so existing outputs refresh themselves. */
const GENERATOR_REVISION = 4;

const STAMP_FILE = ".sdk-stamp.json";

/**
 * Directories a language toolchain creates *inside* the package it is building.
 *
 * Regeneration wipes the output directory, which is right for emitted source —
 * a file from a spec that no longer exists must not survive. It is wrong for
 * build caches: deleting `sdk/rust/target` turns every regeneration into a
 * ~90-second cold `cargo build`, and doing it while cargo holds the directory
 * fails outright with `ENOTEMPTY`.
 *
 * These names are properties of the toolchains, not of our emitters, so they
 * live here rather than being restated by each target. A target that ever
 * legitimately emits one of these names wins: `artifacts` is checked first.
 */
const TOOLCHAIN_BUILD_DIRS: ReadonlySet<string> = new Set([
  "target", // cargo, maven
  ".build", // swiftpm
  "bin", // dotnet
  "obj", // dotnet
  "node_modules",
  ".venv",
  "vendor",
  ".gradle",
]);

/** `<repo>/sdk` — outside the pnpm workspace globs, and gitignored. */
export const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../sdk");

export type RegenerationReason =
  | "up-to-date"
  | "missing"
  | "api-version-changed"
  | "spec-changed"
  | "generator-changed"
  | "forced";

interface Stamp {
  target: string;
  apiVersion: string;
  specHash: string;
  generator: number;
  generatedAt: string;
}

export interface TargetResult {
  target: string;
  packageName: string;
  outDir: string;
  regenerated: boolean;
  reason: RegenerationReason;
  /** The API version the output directory now reflects. */
  apiVersion: string;
  previousApiVersion: string | null;
}

export interface GenerateSdksOptions {
  /** The full OpenAPI document, internal operations included — they're filtered here. */
  document: object;
  /** Target ids to build. Defaults to every registered target. */
  targets?: readonly string[];
  /** Rebuild even when the stamp says the output is current. */
  force?: boolean;
  /** Override the SDK root. Defaults to `<repo>/sdk`. */
  outRoot?: string;
  log?: (message: string) => void;
}

export interface GenerateSdksResult {
  apiVersion: string;
  results: TargetResult[];
}

async function readStamp(outDir: string): Promise<Stamp | null> {
  try {
    return JSON.parse(await readFile(join(outDir, STAMP_FILE), "utf8")) as Stamp;
  } catch {
    return null;
  }
}

async function artifactsPresent(outDir: string, target: SdkTarget): Promise<boolean> {
  for (const artifact of target.artifacts) {
    try {
      await readFile(join(outDir, artifact));
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Why this target needs rebuilding — in the order a reader cares about, so the
 * message names the most meaningful cause when several apply at once.
 */
async function decide(
  outDir: string,
  target: SdkTarget,
  apiVersion: string,
  specHash: string,
  force: boolean,
): Promise<{ reason: RegenerationReason; previousApiVersion: string | null }> {
  const stamp = await readStamp(outDir);
  const previousApiVersion = stamp?.apiVersion ?? null;
  if (force) return { reason: "forced", previousApiVersion };
  if (!stamp || !(await artifactsPresent(outDir, target))) {
    return { reason: "missing", previousApiVersion };
  }
  if (stamp.apiVersion !== apiVersion) return { reason: "api-version-changed", previousApiVersion };
  if (stamp.generator !== GENERATOR_REVISION) {
    return { reason: "generator-changed", previousApiVersion };
  }
  if (stamp.specHash !== specHash) return { reason: "spec-changed", previousApiVersion };
  return { reason: "up-to-date", previousApiVersion };
}

/**
 * Empty `outDir` of everything the generator owns, leaving toolchain build
 * caches in place. Missing directory is fine — that's the first-run case.
 */
async function clean(outDir: string, target: SdkTarget): Promise<void> {
  let entries;
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch {
    return;
  }
  const artifacts = new Set(target.artifacts);
  for (const entry of entries) {
    const preserved =
      entry.isDirectory() && TOOLCHAIN_BUILD_DIRS.has(entry.name) && !artifacts.has(entry.name);
    if (preserved) continue;
    await rm(join(outDir, entry.name), { recursive: true, force: true });
  }
}

function describe(result: TargetResult): string {
  const where = `sdk/${result.target}`;
  switch (result.reason) {
    case "up-to-date":
      return `· ${where} is current (API v${result.apiVersion})`;
    case "missing":
      return `✓ ${where} generated (API v${result.apiVersion})`;
    case "api-version-changed":
      return `✓ ${where} regenerated — API version ${result.previousApiVersion} → ${result.apiVersion}`;
    case "spec-changed":
      return `✓ ${where} regenerated — spec changed without an API version bump (still v${result.apiVersion})`;
    case "generator-changed":
      return `✓ ${where} regenerated — generator revision changed`;
    case "forced":
      return `✓ ${where} regenerated (--force)`;
  }
}

export async function generateSdks(options: GenerateSdksOptions): Promise<GenerateSdksResult> {
  const log = options.log ?? (() => {});
  const outRoot = options.outRoot ?? SDK_ROOT;

  const selected = options.targets?.length
    ? options.targets.map((id) => {
        const target = findTarget(id);
        if (!target) {
          throw new Error(
            `Unknown SDK target "${id}". Available: ${SDK_TARGETS.map((t) => t.id).join(", ")}`,
          );
        }
        return target;
      })
    : SDK_TARGETS;

  const ir = buildSdkIr(options.document, { warn: (message) => log(`  ! ${message}`) });
  // Hash what we publish, not what we build: an internal-only route moving
  // around must not churn a public SDK.
  const specHash = createHash("sha256")
    .update(JSON.stringify(toPublicDocument(options.document)))
    .digest("hex");

  const results: TargetResult[] = [];
  for (const target of selected) {
    const outDir = join(outRoot, target.id);
    const { reason, previousApiVersion } = await decide(
      outDir,
      target,
      ir.apiVersion,
      specHash,
      options.force === true,
    );

    const result: TargetResult = {
      target: target.id,
      packageName: target.packageName,
      outDir,
      regenerated: reason !== "up-to-date",
      reason,
      apiVersion: ir.apiVersion,
      previousApiVersion,
    };

    if (result.regenerated) {
      // Wipe emitted content, keep toolchain build caches — an isolated package
      // should never carry a file from a spec that no longer exists, but it also
      // shouldn't pay for a cold rebuild on every spec bump.
      await clean(outDir, target);
      await mkdir(outDir, { recursive: true });

      await target.generate(ir, {
        outDir,
        log,
        write: async (relPath, contents) => {
          const absolute = join(outDir, relPath);
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(absolute, contents);
        },
      });

      const stamp: Stamp = {
        target: target.id,
        apiVersion: ir.apiVersion,
        specHash,
        generator: GENERATOR_REVISION,
        generatedAt: new Date().toISOString(),
      };
      await writeFile(join(outDir, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
    }

    log(describe(result));
    results.push(result);
  }

  return { apiVersion: ir.apiVersion, results };
}
