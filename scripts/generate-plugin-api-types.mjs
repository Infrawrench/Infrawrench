#!/usr/bin/env node
// Generates a plugin's typed API paths from its provider's OpenAPI document.
//
//   node scripts/generate-plugin-api-types.mjs <plugin-dir-name>...
//   node scripts/generate-plugin-api-types.mjs --all
//
// Reads `plugin-architecture/packages/<plugin>/openapi.config.json`:
//
//   { "specUrl": "https://...", "paths": { "/servers": ["get"], "/servers/{id}": ["get", "delete"] } }
//
// Writes `src/api-types.gen.ts`. Provider documents run to tens of megabytes, so
// only the listed operations and the schemas they reach are kept: the generated
// file stays reviewable and the plugin's type check stays fast. Calling an
// operation the plugin has not listed is a compile error, and the fix is one line
// in the config plus a rerun.
//
// A provider that publishes more than one document lists them, and each writes
// its own `src/api-types.<name>.gen.ts`:
//
//   { "documents": [{ "name": "cloud", "specUrl": "https://...", "paths": { ... } }, ...] }
//
// Where a document is wrong, or too strict for what the plugin sends, `patches`
// (beside `paths`) overwrite one value by JSON pointer before anything else runs.
// Each says why, and one that no longer changes anything, or whose parent has gone,
// fails the run, so a provider fixing its document surfaces rather than rotting:
//
//   "patches": [{ "pointer": "/paths/~1x/post/requestBody/.../required", "value": [], "why": "..." }]
//
// A Swagger 2 document is converted to OpenAPI 3.0 on load, so `paths` and `patches`
// always address the OpenAPI 3 form: a `definitions` schema is at `/components/schemas`
// and a response body under `content`. Its `basePath` moves into `servers`, so paths
// are written without it.
//
// A document that writes a version prefix into every path, where the client's base URL
// has to hold it, names it in `pathPrefix`. Paths outside it are dropped, and `paths`
// and `patches` are written without it:
//
//   { "specUrl": "https://...", "pathPrefix": "/api/v4", "paths": { "/projects": ["get"] } }
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { upgradeFromTwoToThree } from "@scalar/openapi-upgrader/2.0-to-3.0";
import YAML from "yaml";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// openapi-typescript builds its output with TypeScript's JS compiler API. The
// root `typescript` is tsc-rs, which has none, so its import resolves to the
// TypeScript 6 that `website` depends on for the same reason.
const typescriptJsApi = pathToFileURL(
  createRequire(path.join(ROOT, "app/packages/website/package.json")).resolve("typescript"),
).href;
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier === "typescript"
      ? { url: typescriptJsApi, shortCircuit: true }
      : nextResolve(specifier, context),
});
const { default: openapiTS, astToString } = await import("openapi-typescript");
const { default: ts } = await import("typescript");

const PACKAGES = path.join(ROOT, "plugin-architecture/packages");
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

function collectRefs(node, out, mappings) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out, mappings);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/")) out.add(value);
      // A mapping names schemas without a `$ref`, and a schema reached only this
      // way must survive pruning: the document does not validate without it. It may
      // also name one bare, with no pointer at all.
      else if (key === "discriminator" && value?.mapping) {
        for (const target of Object.values(value.mapping)) {
          const ref = target.startsWith("#/") ? target : `#/components/schemas/${target}`;
          out.add(ref);
          mappings.add(ref);
        }
      } else collectRefs(value, out, mappings);
    }
  }
}

/** Read a `#/...` pointer, percent-encoded or not, through any `$ref` on the way. */
function resolvePointer(doc, ref) {
  let cur = doc;
  for (const seg of ref.slice(2).split("/")) {
    if (typeof cur?.$ref === "string" && cur.$ref.startsWith("#/")) {
      cur = resolvePointer(doc, cur.$ref);
    }
    cur = cur?.[decodeURIComponent(seg).replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return cur;
}

/**
 * Bundlers point one operation at a schema inside another (`#/paths/...`), which
 * pruning may remove, or inside a component (`#/components/schemas/Tag/allOf/0`),
 * which openapi-typescript renders as a property the type does not have. Put the
 * schema where it is used.
 */
function inlineDeepRefs(doc) {
  const deep = /^#\/(paths\/|components\/[^/]+\/[^/]+\/)/;
  const expand = (node, within) => {
    if (Array.isArray(node)) return node.map((item) => expand(item, within));
    if (!node || typeof node !== "object") return node;
    const ref = node.$ref;
    if (typeof ref === "string" && deep.test(ref) && !within.has(ref)) {
      return expand(resolvePointer(doc, ref), new Set(within).add(ref));
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, expand(v, within)]));
  };
  doc.paths = expand(doc.paths, new Set());
  doc.components = expand(doc.components, new Set());
}

/** Keep the listed operations and everything they transitively reference. */
function prune(doc, wanted) {
  const paths = {};
  for (const [route, methods] of Object.entries(wanted)) {
    const item = doc.paths?.[route];
    if (!item) throw new Error(`${route} is not in the document`);
    const kept = {};
    for (const [key, value] of Object.entries(item)) {
      if (!METHODS.includes(key)) kept[key] = value;
      else if (methods.includes(key)) kept[key] = value;
    }
    for (const method of methods) {
      if (!item[method]) throw new Error(`${method.toUpperCase()} ${route} is not in the document`);
    }
    paths[route] = kept;
  }

  const seen = new Set();
  const queue = new Set();
  const mappings = new Set();
  collectRefs(paths, queue, mappings);
  while (queue.size > 0) {
    const [ref] = queue;
    queue.delete(ref);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const target = resolvePointer(doc, ref);
    if (target === undefined) {
      // A mapping's value need not lead anywhere (OpenRouter's does not); a `$ref` must.
      if (mappings.has(ref)) continue;
      throw new Error(`Dangling reference ${ref}`);
    }
    const next = new Set();
    collectRefs(target, next, mappings);
    for (const r of next) if (!seen.has(r)) queue.add(r);
  }

  // Nothing else survives: `webhooks` and `x-webhooks` point into `components`, and
  // whatever they reach has just been left out of it.
  const pruned = { openapi: doc.openapi, info: doc.info, paths, components: {} };
  for (const ref of seen) {
    const segments = ref.slice(2).split("/");
    if (segments[0] !== "components") continue;
    const [, section, name] = segments;
    (pruned.components[section] ??= {})[name] = doc.components[section][name];
  }
  return pruned;
}

/** Keywords that only feed doc comments, which were 73% of Hetzner's generated bytes. */
const DOC_KEYWORDS = new Set([
  "description",
  "title",
  "summary",
  "example",
  "examples",
  "externalDocs",
]);
/** Under these, keys are names a provider chose, so `description` may be a real field. */
const NAME_MAPS = new Set(["properties", "patternProperties", "schemas", "$defs", "headers"]);
const LITERAL_VALUES = new Set(["default", "enum", "const"]);

function withoutDocs(node, keysAreNames = false) {
  if (Array.isArray(node)) return node.map((item) => withoutDocs(item));
  if (!node || typeof node !== "object") return node;
  const kept = {};
  for (const [key, value] of Object.entries(node)) {
    if (keysAreNames) kept[key] = withoutDocs(value);
    else if (LITERAL_VALUES.has(key)) kept[key] = value;
    else if (!DOC_KEYWORDS.has(key)) kept[key] = withoutDocs(value, NAME_MAPS.has(key));
  }
  return kept;
}

/**
 * The client only ever returns a 2xx body; errors reach callers as a message. An
 * operation with no 2xx says how it succeeds under `default`, if anywhere (Gemini's
 * document does this throughout), so that stands in for a 200.
 */
function dropErrorResponses(doc) {
  for (const item of Object.values(doc.paths)) {
    for (const method of METHODS) {
      const responses = item[method]?.responses ?? {};
      const codes = Object.keys(responses);
      if (responses.default && !codes.some((code) => code.startsWith("2"))) {
        responses["200"] = responses.default;
      }
      for (const code of codes) {
        if (!code.startsWith("2")) delete responses[code];
      }
    }
  }
}

/** Below this a named type costs more than the text it saves. */
const MIN_SHARED_CHARS = 256;

/**
 * Some providers inline every schema, so one project object is written out in every
 * operation that returns one: three quarters of Vercel's generated bytes were copies.
 * Give each repeated type one alias, named by a hash so that a change to one shape
 * does not rename the others. This runs on the generated TypeScript rather than the
 * document because text that is equal is the same type, whereas moving a schema into
 * `components` changes how openapi-typescript reads its discriminators.
 */
function shareRepeatedTypes(source) {
  const file = ts.createSourceFile("gen.ts", source, ts.ScriptTarget.Latest, true);
  const shareable = (node) =>
    ts.isTypeLiteralNode(node) || ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node);
  const textOf = (node) => node.getText(file).replace(/\s+/g, " ");

  const counts = new Map();
  const count = (node) => {
    if (shareable(node)) counts.set(textOf(node), (counts.get(textOf(node)) ?? 0) + 1);
    ts.forEachChild(node, count);
  };
  count(file);

  const aliases = new Map();
  const nameFor = (node) => {
    const text = textOf(node);
    const known = aliases.get(text);
    if (known) return known.name;
    const property = ts.isPropertySignature(node.parent) ? node.parent.name.getText(file) : "";
    const hint = /^[A-Za-z_][A-Za-z0-9_]*$/.test(property) ? property : "Shared";
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
    const entry = { name: `${hint}_${hash}`, body: "" };
    aliases.set(text, entry);
    entry.body = render(node, node.getStart(file), node.getEnd());
    return entry.name;
  };
  /** The text from `start` to `end`, with each outermost repeated type replaced. */
  function render(root, start, end) {
    let out = "";
    let at = start;
    const walk = (node) => {
      ts.forEachChild(node, (child) => {
        const repeated =
          shareable(child) &&
          (counts.get(textOf(child)) ?? 0) >= 2 &&
          textOf(child).length >= MIN_SHARED_CHARS;
        if (!repeated) return walk(child);
        out += source.slice(at, child.getStart(file)) + nameFor(child);
        at = child.getEnd();
      });
    };
    walk(root);
    return out + source.slice(at, end);
  }
  let result = render(file, 0, source.length);

  // Counting ran before anything moved, so a type repeated only inside a type that
  // got an alias now has one user. Put those back.
  const entries = [...aliases.values()];
  const uses = (name) => {
    const pattern = new RegExp(`\\b${name}\\b`, "g");
    let total = result.match(pattern)?.length ?? 0;
    for (const entry of entries) total += entry.body.match(pattern)?.length ?? 0;
    return total;
  };
  for (const entry of [...entries]) {
    if (uses(entry.name) !== 1) continue;
    const pattern = new RegExp(`\\b${entry.name}\\b`);
    entries.splice(entries.indexOf(entry), 1);
    result = result.replace(pattern, () => entry.body);
    for (const other of entries) other.body = other.body.replace(pattern, () => entry.body);
  }
  const declarations = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `type ${entry.name} = ${entry.body};`)
    .join("\n");
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return printer.printFile(
    ts.createSourceFile("gen.ts", `${result}\n${declarations}\n`, ts.ScriptTarget.Latest, true),
  );
}

function applyPatches(doc, patches = []) {
  for (const { pointer, value, why } of patches) {
    if (!why) throw new Error(`Patch ${pointer} does not say why`);
    const segments = pointer.split("/");
    const key = segments.pop().replaceAll("~1", "/").replaceAll("~0", "~");
    const parent = resolvePointer(doc, `#${segments.join("/")}`);
    if (!parent || typeof parent !== "object") throw new Error(`Patch ${pointer} has no parent`);
    if (JSON.stringify(parent[key]) === JSON.stringify(value)) {
      throw new Error(`Patch ${pointer} changes nothing; remove it`);
    }
    parent[key] = value;
  }
}

async function loadDocument(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const text = await response.text();
  const doc = text.trimStart().startsWith("{") ? JSON.parse(text) : YAML.parse(text);
  return doc.swagger ? upgradeFromTwoToThree(doc) : doc;
}

function stripPathPrefix(doc, prefix) {
  const kept = Object.entries(doc.paths ?? {}).filter(([route]) => route.startsWith(`${prefix}/`));
  if (kept.length === 0) throw new Error(`No path in the document starts with ${prefix}/`);
  doc.paths = Object.fromEntries(kept.map(([route, item]) => [route.slice(prefix.length), item]));
}

async function generateDocument(plugin, dir, config, fileName) {
  const doc = await loadDocument(config.specUrl);
  inlineDeepRefs(doc);
  if (config.pathPrefix) stripPathPrefix(doc, config.pathPrefix);
  applyPatches(doc, config.patches);
  // Before pruning, so that what only an example refers to is not kept or chased.
  const pruned = prune(withoutDocs(doc), config.paths);
  dropErrorResponses(pruned);
  // `defaultNonNullable` would make any field with a server-side default required
  // in request bodies too, which is the opposite of what a default means.
  const ast = await openapiTS(pruned, {
    alphabetize: true,
    defaultNonNullable: false,
  });
  const header = `// Generated by scripts/generate-plugin-api-types.mjs from ${config.specUrl}.
// Do not edit. Add an operation to openapi.config.json and rerun.
/* eslint-disable */
`;
  const out = path.join(dir, "src", fileName);
  fs.writeFileSync(out, header + shareRepeatedTypes(astToString(ast)));
  const operations = Object.values(config.paths).reduce((n, m) => n + m.length, 0);
  console.log(`${plugin}/${fileName}: ${operations} operations, ${fs.statSync(out).size} bytes`);
}

async function generate(plugin) {
  const dir = path.join(PACKAGES, plugin);
  const config = JSON.parse(fs.readFileSync(path.join(dir, "openapi.config.json"), "utf8"));
  if (!config.documents) return generateDocument(plugin, dir, config, "api-types.gen.ts");
  for (const document of config.documents) {
    await generateDocument(plugin, dir, document, `api-types.${document.name}.gen.ts`);
  }
}

const args = process.argv.slice(2);
const plugins = args.includes("--all")
  ? fs
      .readdirSync(PACKAGES)
      .filter((d) => fs.existsSync(path.join(PACKAGES, d, "openapi.config.json")))
  : args;
if (plugins.length === 0) {
  console.error("Usage: generate-plugin-api-types.mjs <plugin>... | --all");
  process.exit(1);
}
for (const plugin of plugins) await generate(plugin);
