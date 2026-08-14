/**
 * Reports what each committed translation catalog is missing, offline.
 *
 * `gt translate` has no local incremental mode: on a `gt`-format project it
 * re-extracts every marked string and sends the whole set, and its dedupe is
 * server-side, keyed by hashes this repo's hand-authored catalogs were never
 * uploaded under. So the "what actually changed" signal has to come from here.
 *
 * Extraction uses the gt CLI's own parser, so the hashes are exactly the ones
 * `gt translate` would compute and the ones gt-react resolves at render time.
 * Needs no API key and contacts nothing.
 *
 *   pnpm --filter @infrawrench/web translations:status
 *   pnpm --filter @infrawrench/web translations:status --json
 *   pnpm --filter @infrawrench/web translations:status --emit-batches <dir>
 *
 * `--emit-batches` writes the untranslated sources as `<app>-<locale>-<n>.json`
 * batches of `{i, s}` objects, plus a `-hashes.json` per locale to key the
 * finished translations back — the shapes the workflow in KNOWLEDGE.md
 * ("Filling the catalogs") consumes.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInlineUpdates } from "gt/react/parse/createInlineUpdates";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPS = ["web", "desktop"];
const BATCH_SIZE = 470;

/** Extract every marked string for one app, keyed by content hash. */
async function extract(appDir, config) {
  // The CLI's matcher resolves `src` globs against process.cwd().
  const previous = process.cwd();
  process.chdir(appDir);
  try {
    const { updates, errors } = await createInlineUpdates("gt-react", false, config.src, {});
    if (errors.length) {
      console.error(`[translation-status] extraction errors in ${appDir}:`);
      for (const e of errors.slice(0, 10)) console.error(`  ${e}`);
      process.exitCode = 1;
    }
    const byHash = new Map();
    for (const u of updates) if (u.metadata.hash) byHash.set(u.metadata.hash, u);
    return byHash;
  } finally {
    process.chdir(previous);
  }
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const emitAt = args.includes("--emit-batches")
  ? args[args.indexOf("--emit-batches") + 1]
  : undefined;

const report = {};
const missingSources = {};

for (const app of APPS) {
  const appDir = resolve(__dirname, "../..", app);
  const config = JSON.parse(readFileSync(resolve(appDir, "gt.config.json"), "utf8"));
  const sources = await extract(appDir, config);
  report[app] = {};

  for (const locale of config.locales) {
    const catalogPath = resolve(appDir, `src/_gt/${locale}.json`);
    const catalog = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, "utf8")) : {};

    const missing = [...sources.keys()].filter((h) => !(h in catalog));
    const orphaned = Object.keys(catalog).filter((h) => !sources.has(h));

    // Only plain ICU strings are batchable; a JSX tree has to be hand-authored
    // against its node shape, so count those separately rather than silently
    // dropping them from the batches.
    const key = `${app}:${locale}`;
    missingSources[key] = missing
      .map((h) => ({ hash: h, update: sources.get(h) }))
      .filter(({ update }) => update.dataFormat === "ICU" && typeof update.source === "string")
      .map(({ hash, update }) => ({ hash, source: update.source }));

    report[app][locale] = {
      missing: missing.length,
      orphaned: orphaned.length,
      jsx: missing.length - missingSources[key].length,
    };
  }
}

if (asJson) {
  console.log(JSON.stringify({ report, missingSources }, null, 2));
} else {
  for (const app of APPS) {
    console.log(`\n${app}`);
    for (const [locale, counts] of Object.entries(report[app])) {
      const state =
        counts.missing === 0 && counts.orphaned === 0
          ? "up to date"
          : [
              counts.missing ? `${counts.missing} missing` : "",
              counts.orphaned ? `${counts.orphaned} orphaned` : "",
              counts.jsx ? `(${counts.jsx} of the missing are JSX trees)` : "",
            ]
              .filter(Boolean)
              .join(", ");
      console.log(`  ${locale.padEnd(3)} ${state}`);
    }
  }
  console.log(
    "\nOrphaned entries are translations whose source string changed or was deleted;" +
      "\nthey are inert at runtime and can be pruned with `gt generate`.",
  );
}

if (emitAt) {
  mkdirSync(emitAt, { recursive: true });
  let written = 0;
  for (const [key, entries] of Object.entries(missingSources)) {
    if (entries.length === 0) continue;
    const stem = key.replace(":", "-");
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const chunk = entries.slice(i, i + BATCH_SIZE).map((e, j) => ({ i: i + j, s: e.source }));
      writeFileSync(
        resolve(emitAt, `${stem}-${i / BATCH_SIZE}.json`),
        JSON.stringify(chunk, null, 1),
      );
      written++;
    }
    writeFileSync(resolve(emitAt, `${stem}-hashes.json`), JSON.stringify(entries, null, 1));
  }
  console.log(`\n[translation-status] wrote ${written} batch file(s) to ${emitAt}`);
}
