import { visit, SKIP } from "unist-util-visit";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCREENSHOT_RE = /<insert\s+\[([^\]]+)\]\s+here>/g;

function isExternal(url) {
  return /^[a-z][a-z0-9+\-.]*:/i.test(url) || url.startsWith("//") || url.startsWith("#");
}

// Strip ".md" from internal links so relative URLs resolve to the routed
// equivalents under /docs/<section>/<slug>. Anchor fragments are preserved.
function rewriteLink(url) {
  if (!url || isExternal(url)) return url;
  return url.replace(/\.md(?=$|#|\?)/, "");
}

// `<skill id="..." />` on its own line: a card for the agent skill in
// `src/data/skills/<id>/`, whose button opens the skill's modal. The page
// renders the modal (`pages/docs/[...slug].astro`); this only knows the files.
export const SKILL_RE = /^<skill\s+id="([a-z0-9-]+)"\s*\/?>\s*(?:<\/skill>)?$/;

function skillsDir() {
  const here = new URL("../data/skills/", import.meta.url);
  if (here.protocol === "file:" && existsSync(fileURLToPath(here))) return fileURLToPath(here);
  return `${process.cwd()}/src/data/skills/`;
}

function skillCardHtml(id) {
  const dir = `${skillsDir()}${id}/`;
  if (!existsSync(`${dir}skill.json`))
    throw new Error(`<skill id="${id}" />: no skill at src/data/skills/${id}`);
  const meta = JSON.parse(readFileSync(`${dir}skill.json`, "utf8"));
  const refs = existsSync(`${dir}references`)
    ? readdirSync(`${dir}references`)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => `references/${f}`)
    : [];
  const files = ["SKILL.md", ...refs].join(" · ");
  return `<div class="skill-card"><span class="skill-card-label">Agent skill</span><p class="skill-card-title">${escapeHtml(meta.title)}</p><p class="skill-card-summary">${escapeHtml(meta.summary)}</p><p class="skill-card-files">${escapeHtml(files)}</p><div class="skill-card-actions"><button type="button" class="skill-card-open" data-open-modal="skill-modal-${id}">Add it to your agent</button><a href="/skills/${id}.md">Read it as one file</a></div></div>`;
}

function placeholderHtml(description) {
  return `<div class="screenshot-placeholder" data-screenshot-needed="${escapeAttr(description)}"><span class="screenshot-placeholder-label">Screenshot needed</span><span class="screenshot-placeholder-desc">${escapeHtml(description)}</span></div>`;
}

function paragraphInnerValue(node) {
  if (node.type !== "paragraph") return null;
  const parts = [];
  for (const child of node.children) {
    if (child.type === "text" || child.type === "html") parts.push(child.value);
    else return null;
  }
  return parts.join("");
}

export default function remarkDocs() {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (node.type === "link" && typeof node.url === "string") {
        node.url = rewriteLink(node.url);
        return;
      }

      if (!parent || !Array.isArray(parent.children) || typeof index !== "number") return;

      if (node.type === "html" && SKILL_RE.test(node.value.trim())) {
        node.value = skillCardHtml(node.value.trim().match(SKILL_RE)[1]);
        return;
      }

      // Block-level html node (remark parses `<insert ...>` as html).
      if (node.type === "html" && SCREENSHOT_RE.test(node.value)) {
        SCREENSHOT_RE.lastIndex = 0;
        const replaced = node.value.replace(SCREENSHOT_RE, (_, desc) => placeholderHtml(desc));
        node.value = replaced;
        return;
      }

      if (node.type !== "paragraph") return;

      // Paragraph whose entire text is placeholder(s): replace with block-level
      // html nodes so the output isn't wrapped in an empty <p>.
      const flat = paragraphInnerValue(node);
      if (flat !== null) {
        const matches = [...flat.matchAll(SCREENSHOT_RE)];
        const onlyPlaceholders =
          matches.length > 0 && flat.replace(SCREENSHOT_RE, "").trim() === "";
        if (onlyPlaceholders) {
          const replacements = matches.map((m) => ({
            type: "html",
            value: placeholderHtml(m[1]),
          }));
          parent.children.splice(index, 1, ...replacements);
          return [SKIP, index + replacements.length];
        }
      }

      // Otherwise inline-replace placeholders within the paragraph's children.
      const newChildren = [];
      let mutated = false;
      for (const child of node.children) {
        if ((child.type !== "text" && child.type !== "html") || !SCREENSHOT_RE.test(child.value)) {
          newChildren.push(child);
          continue;
        }
        mutated = true;
        SCREENSHOT_RE.lastIndex = 0;
        let last = 0;
        let m;
        while ((m = SCREENSHOT_RE.exec(child.value)) !== null) {
          const before = child.value.slice(last, m.index);
          if (before) newChildren.push({ type: child.type, value: before });
          newChildren.push({ type: "html", value: placeholderHtml(m[1]) });
          last = m.index + m[0].length;
        }
        const after = child.value.slice(last);
        if (after) newChildren.push({ type: child.type, value: after });
      }
      if (mutated) node.children = newChildren;
    });
  };
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
