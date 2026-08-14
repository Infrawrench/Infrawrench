/**
 * Finds user-facing strings that are still unmarked for translation.
 *
 * `translations:status` answers "are the catalogs current for what is marked".
 * This answers the prior question — "what has nobody marked yet" — which is
 * the only way to know how much of the UI actually shows in English.
 *
 * It parses every component with Babel and reports two things per file:
 * JSX text nodes, and string literals in user-facing attributes
 * (placeholder / title / aria-label / alt / label) plus toast calls. Anything
 * already inside a <T> element or passed to gt()/t()/msg() is excluded, as are
 * strings with no letters, single words that are obviously identifiers, and
 * the generated plugin manifest.
 *
 *   pnpm --filter @infrawrench/web translations:audit
 *   pnpm --filter @infrawrench/web translations:audit --json
 *   pnpm --filter @infrawrench/web translations:audit --dir ui/src/settings
 *
 * A heuristic, deliberately: it is a work-list, not a gate. Read its output as
 * "these look untranslated", then convert and re-run.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(__dirname, "../..");
const ROOTS = ["ui/src", "web/src", "desktop/src"];
const ATTRS = new Set(["placeholder", "title", "aria-label", "alt", "label", "ariaLabel"]);
const SKIP_FILES = [/\.test\.[jt]sx?$/, /__tests__/, /\.gen\.ts$/, /routeTree/];

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const onlyDir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : undefined;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !SKIP_FILES.some((r) => r.test(full))) out.push(full);
  }
  return out;
}

/** Prose-ish? Filters out identifiers, codes, css-ish values and punctuation. */
function looksUserFacing(text) {
  const t = text.trim();
  if (t.length < 2 || !/[A-Za-z]/.test(t)) return false;
  if (!/[A-Z a-z]/.test(t)) return false;
  if (/^[a-z0-9_-]+$/.test(t) && !t.includes(" ")) return false; // slug/identifier
  if (/^[A-Z_]+$/.test(t)) return false; // CONSTANT
  if (/^(https?:|\/|\.|#|\{)/.test(t)) return false;
  if (/^[a-z]+([A-Z][a-z]+)+$/.test(t)) return false; // camelCase
  return true;
}

const results = [];

for (const root of ROOTS) {
  const base = resolve(PACKAGES, root);
  let files;
  try {
    files = walk(base);
  } catch {
    continue;
  }
  for (const file of files) {
    const rel = relative(PACKAGES, file);
    if (onlyDir && !rel.startsWith(onlyDir)) continue;
    const code = readFileSync(file, "utf8");
    let ast;
    try {
      ast = parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
    } catch {
      continue;
    }

    const hits = [];
    const stack = [];

    const visit = (node, parent) => {
      if (!node || typeof node.type !== "string") return;

      // Inside <T>…</T> everything is already marked.
      const isT =
        node.type === "JSXElement" &&
        (node.openingElement?.name?.name === "T" || node.openingElement?.name?.name === "Tx");
      if (isT) stack.push("T");

      // gt("…") / t`…` / msg("…") arguments are marked.
      const isMarkedCall =
        node.type === "CallExpression" &&
        ((node.callee?.type === "Identifier" &&
          ["gt", "t", "msg", "m"].includes(node.callee.name)) ||
          (node.callee?.type === "MemberExpression" && node.callee.property?.name === "rich"));
      if (isMarkedCall) stack.push("call");

      if (stack.length === 0) {
        if (node.type === "JSXText" && looksUserFacing(node.value)) {
          hits.push({ line: node.loc.start.line, kind: "jsx-text", text: node.value.trim() });
        }
        if (
          node.type === "JSXAttribute" &&
          ATTRS.has(node.name?.name) &&
          node.value?.type === "StringLiteral" &&
          looksUserFacing(node.value.value)
        ) {
          hits.push({
            line: node.loc.start.line,
            kind: `attr:${node.name.name}`,
            text: node.value.value,
          });
        }
        if (
          node.type === "CallExpression" &&
          node.callee?.type === "MemberExpression" &&
          node.callee.object?.name === "toast" &&
          node.arguments?.[0]?.type === "StringLiteral" &&
          looksUserFacing(node.arguments[0].value)
        ) {
          hits.push({ line: node.loc.start.line, kind: "toast", text: node.arguments[0].value });
        }
      }

      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach((c) => visit(c, node));
        else if (value && typeof value.type === "string") visit(value, node);
      }

      if (isT || isMarkedCall) stack.pop();
    };

    visit(ast.program, null);
    if (hits.length) results.push({ file: rel, hits });
  }
}

results.sort((a, b) => b.hits.length - a.hits.length);
const total = results.reduce((n, r) => n + r.hits.length, 0);

if (asJson) {
  console.log(JSON.stringify({ total, files: results }, null, 2));
} else {
  const byArea = new Map();
  for (const r of results) {
    const area = r.file.split("/").slice(0, 3).join("/");
    byArea.set(area, (byArea.get(area) ?? 0) + r.hits.length);
  }
  console.log(`${total} unmarked user-facing strings in ${results.length} files\n`);
  console.log("By area:");
  for (const [area, n] of [...byArea.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${String(n).padStart(5)}  ${area}`);
  }
  console.log("\nWorst files:");
  for (const r of results.slice(0, 20)) {
    console.log(`  ${String(r.hits.length).padStart(4)}  ${r.file}`);
  }
}
