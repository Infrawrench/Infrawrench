/**
 * Emits every untranslated source as flat batches, and merges the results back
 * into the catalogs.
 *
 * `translations:status --emit-batches` only covers plain ICU strings. A `<T>`
 * block is extracted as a *tree* (`{t,i,c}` nodes with `{i,k,v}` variable
 * placeholders), which cannot be handed to a translator as a string. This tool
 * flattens each tree's text leaves into ordinary units, then rebuilds the tree
 * around the translations — structure and variables preserved byte-for-byte,
 * because only string leaves are ever replaced.
 *
 *   node scripts/translation-batches.mjs emit <dir> [--size 800]
 *   node scripts/translation-batches.mjs merge <dir>
 *
 * emit  writes `units.json` (the master list) plus `<locale>-<n>.json` batches
 *       of `[{i, s}]` — the shape a translation agent answers as `[{i, t}]`.
 * merge reads `<locale>-<n>.out.json`, checks every batch for length, index
 *       coverage, ICU-placeholder parity, forbidden characters and empties,
 *       refuses to write anything if a single check fails, then updates both
 *       apps' catalogs with the hashes each app actually uses.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInlineUpdates } from "gt/react/parse/createInlineUpdates";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(__dirname, "../..");
const APPS = ["web", "desktop"];
const LOCALES = ["es", "fr", "de", "ja", "zh"];

const [mode, dir, ...rest] = process.argv.slice(2);
const size = rest.includes("--size") ? Number(rest[rest.indexOf("--size") + 1]) : 800;
if (!mode || !dir) {
  console.error("usage: translation-batches.mjs <emit|merge> <dir> [--size N]");
  process.exit(1);
}

/** Extract every marked source for one app, keyed by hash. */
async function extract(app) {
  const appDir = resolve(PACKAGES, app);
  const cfg = JSON.parse(readFileSync(resolve(appDir, "gt.config.json"), "utf8"));
  const cwd = process.cwd();
  process.chdir(appDir);
  try {
    const { updates } = await createInlineUpdates("gt-react", false, cfg.src, {});
    const byHash = new Map();
    for (const u of updates) if (u.metadata.hash) byHash.set(u.metadata.hash, u);
    return byHash;
  } finally {
    process.chdir(cwd);
  }
}

const catalogPath = (app, locale) => resolve(PACKAGES, app, `src/_gt/${locale}.json`);
const readCatalog = (app, locale) => {
  const p = catalogPath(app, locale);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
};

/** Walk a JSX tree's string leaves. `visit(text, path)` returns a replacement. */
function mapLeaves(node, visit, path = []) {
  if (typeof node === "string") return visit(node, path.join("."));
  if (Array.isArray(node)) return node.map((c, i) => mapLeaves(c, visit, [...path, i]));
  if (node && typeof node === "object" && "c" in node) {
    return { ...node, c: mapLeaves(node.c, visit, [...path, "c"]) };
  }
  return node; // variable placeholder or other non-text node — never translated
}

const icuVars = (s) => [...String(s).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();

if (mode === "emit") {
  const sources = new Map(); // hash -> update (union of both apps)
  const missing = new Set();
  for (const app of APPS) {
    const byHash = await extract(app);
    for (const [h, u] of byHash) sources.set(h, u);
    // A hash counts as missing if any locale lacks it.
    for (const locale of LOCALES) {
      const cat = readCatalog(app, locale);
      for (const h of byHash.keys()) if (!(h in cat)) missing.add(h);
    }
  }

  const units = [];
  for (const hash of missing) {
    const u = sources.get(hash);
    if (!u) continue;
    if (u.dataFormat === "ICU" && typeof u.source === "string") {
      units.push({ key: hash, kind: "icu", text: u.source });
    } else {
      mapLeaves(u.source, (text, path) => {
        if (String(text).trim()) units.push({ key: `${hash}#${path}`, kind: "jsx", text });
        return text;
      });
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "units.json"), JSON.stringify(units));
  // The trees themselves, so merge can rebuild without re-extracting.
  const trees = {};
  for (const hash of missing) {
    const u = sources.get(hash);
    if (u && u.dataFormat !== "ICU") trees[hash] = u.source;
  }
  writeFileSync(resolve(dir, "trees.json"), JSON.stringify(trees));

  let batches = 0;
  for (const locale of LOCALES) {
    for (let i = 0; i < units.length; i += size) {
      const chunk = units.slice(i, i + size).map((u, j) => ({ i: i + j, s: u.text }));
      writeFileSync(resolve(dir, `${locale}-${i / size}.json`), JSON.stringify(chunk));
      batches++;
    }
  }
  console.log(
    `${units.length} units (${units.filter((u) => u.kind === "jsx").length} JSX leaves), ` +
      `${Object.keys(trees).length} trees, ${batches} batch files of ${size}`,
  );
}

if (mode === "merge") {
  const units = JSON.parse(readFileSync(resolve(dir, "units.json"), "utf8"));
  const trees = JSON.parse(readFileSync(resolve(dir, "trees.json"), "utf8"));
  const problems = [];
  const translated = {}; // locale -> unit key -> text

  for (const locale of LOCALES) {
    translated[locale] = {};
    const outs = readdirSync(dir).filter(
      (f) => f.startsWith(`${locale}-`) && f.endsWith(".out.json"),
    );
    if (outs.length === 0) problems.push(`${locale}: no output files`);
    for (const file of outs) {
      const batchIndex = Number(file.slice(locale.length + 1, -".out.json".length));
      const input = JSON.parse(readFileSync(resolve(dir, `${locale}-${batchIndex}.json`), "utf8"));
      let data;
      try {
        data = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
      } catch (e) {
        problems.push(`${file}: unparseable (${e.message})`);
        continue;
      }
      if (!Array.isArray(data) || data.length !== input.length) {
        problems.push(`${file}: length ${data?.length} != ${input.length}`);
        continue;
      }
      const byIndex = new Map(data.map((e) => [e?.i, e?.t]));
      for (const { i, s } of input) {
        const t = byIndex.get(i);
        if (typeof t !== "string" || !t.trim()) {
          problems.push(`${file}[${i}]: empty/missing`);
          continue;
        }
        if (String(icuVars(s)) !== String(icuVars(t))) {
          problems.push(`${file}[${i}]: ICU vars ${icuVars(s)} -> ${icuVars(t)}`);
          continue;
        }
        if ([..."{}<>"].some((c) => t.includes(c) && !s.includes(c)) || /'[{}]/.test(t)) {
          problems.push(`${file}[${i}]: forbidden character`);
          continue;
        }
        translated[locale][units[i].key] = t;
      }
    }
  }

  if (problems.length) {
    console.error(`REFUSING TO MERGE — ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 25)) console.error("  " + p);
    process.exit(1);
  }

  // Rebuild JSX trees from their translated leaves, then write per app.
  for (const app of APPS) {
    const byHash = await extract(app);
    for (const locale of LOCALES) {
      const cat = readCatalog(app, locale);
      let added = 0;
      for (const [hash] of byHash) {
        if (hash in cat) continue;
        const direct = translated[locale][hash];
        if (direct !== undefined) {
          cat[hash] = direct;
          added++;
        } else if (trees[hash]) {
          cat[hash] = mapLeaves(trees[hash], (text, path) =>
            String(text).trim() ? (translated[locale][`${hash}#${path}`] ?? text) : text,
          );
          added++;
        }
      }
      writeFileSync(catalogPath(app, locale), JSON.stringify(cat, null, 2) + "\n");
      console.log(`${app} ${locale}: +${added} -> ${Object.keys(cat).length}`);
    }
  }
}
