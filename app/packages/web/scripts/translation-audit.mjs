/**
 * Gate: no user-facing string may be neither marked for translation nor
 * explicitly excused.
 *
 * `translations:status` answers "are the catalogs current for what is marked".
 * This answers the prior question — "what has nobody marked yet" — and fails
 * (exit 1) when the answer is not "nothing".
 *
 * It parses every component with Babel and flags, per file: JSX text nodes,
 * string literals in user-facing attributes (placeholder / title / aria-label /
 * alt / label) and toast calls. Anything already inside a <T> element or passed
 * to gt()/t()/msg() is excluded, as are strings with no letters, single words
 * that are obviously identifiers, and the generated plugin manifest.
 *
 * A string that is deliberately not translated must carry an ignore marker
 * with a reason, on the same line or the line above:
 *
 *   // i18n-ignore: IANA timezone identifier
 *   placeholder="Europe/Berlin"
 *
 *   {\/* i18n-ignore: product name *\/}
 *   1Password
 *
 * A marker with no reason fails the gate; so does a stale marker that no
 * longer suppresses anything (delete it, or the excuse outlives the string).
 *
 *   pnpm --filter @infrawrench/web translations:audit
 *   pnpm --filter @infrawrench/web translations:audit --json
 *   pnpm --filter @infrawrench/web translations:audit --dir ui/src/settings
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
const problems = []; // marker misuse: missing reason, stale marker

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

    // Every `i18n-ignore` comment in the file, keyed by the line it ends on.
    // A marker suppresses hits on that line and the next one.
    const markers = [];
    for (const comment of ast.comments ?? []) {
      const text = comment.value.trim();
      if (!/^i18n-ignore\b/.test(text)) continue;
      const reason = text.replace(/^i18n-ignore:?/, "").trim();
      const marker = { line: comment.loc.end.line, reason, used: false };
      markers.push(marker);
      if (!reason) {
        problems.push({
          file: rel,
          line: marker.line,
          kind: "missing-reason",
          message: "i18n-ignore has no reason; write `i18n-ignore: <why this stays English>`",
        });
      }
    }
    const suppressed = (line) => {
      let found;
      for (const m of markers) {
        if (m.line === line || m.line === line - 1) {
          m.used = true;
          found = m;
        }
      }
      return found;
    };

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
          // The node starts at the previous sibling's closing brace; the line
          // that matters for marker matching is where the text itself begins.
          const leading = node.value.match(/^\s*/)[0];
          const line = node.loc.start.line + (leading.match(/\n/g) ?? []).length;
          if (!suppressed(line)) hits.push({ line, kind: "jsx-text", text: node.value.trim() });
        }
        if (
          node.type === "JSXAttribute" &&
          ATTRS.has(node.name?.name) &&
          node.value?.type === "StringLiteral" &&
          looksUserFacing(node.value.value)
        ) {
          if (!suppressed(node.loc.start.line))
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
          if (!suppressed(node.loc.start.line))
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

    for (const m of markers) {
      if (!m.used)
        problems.push({
          file: rel,
          line: m.line,
          kind: "stale-marker",
          message: "i18n-ignore no longer suppresses anything; delete it",
        });
    }

    if (hits.length) results.push({ file: rel, hits });
  }
}

results.sort((a, b) => a.file.localeCompare(b.file));
const total = results.reduce((n, r) => n + r.hits.length, 0);
const failed = total > 0 || problems.length > 0;

if (asJson) {
  console.log(JSON.stringify({ total, files: results, problems }, null, 2));
} else {
  for (const r of results) {
    for (const h of r.hits) {
      console.log(`${r.file}:${h.line}  ${h.kind}  ${JSON.stringify(h.text)}`);
    }
  }
  for (const p of problems) {
    console.log(`${p.file}:${p.line}  ${p.kind}  ${p.message}`);
  }
  if (failed) {
    console.log(
      `\n${total} unmarked user-facing string(s), ${problems.length} marker problem(s).` +
        '\nMark strings with gt()/<T> (see CLAUDE.md, "UI translations"), or excuse a' +
        "\ndeliberately-English string with `// i18n-ignore: <reason>` on it or the line above.",
    );
  } else {
    console.log("translations:audit clean — every user-facing string is marked or excused.");
  }
}

if (failed) process.exitCode = 1;
