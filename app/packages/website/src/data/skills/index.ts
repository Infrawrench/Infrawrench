// Agent skills offered on the site: the homepage's "Use with your coding
// agent" modal, docs pages (`<skill id="..." />`), and raw files under
// /skills/<id>/ that an agent can fetch.
//
// A skill is a folder here: `skill.json` (title, summary, description),
// `SKILL.md` (the instructions, without frontmatter) and any number of
// `references/*.md` the instructions point at. Adding a folder adds a skill
// everywhere; adding a reference file adds it to that skill. The remark
// plugin that renders the docs card reads the same folders from disk
// (`lib/remark-docs.mjs`), so keep the layout in step with it.

export interface SkillFile {
  /** Path inside the skill's folder: `SKILL.md`, `references/mapping.md`. */
  path: string;
  content: string;
}

export interface Skill {
  id: string;
  title: string;
  /** One sentence for people, on cards and in the modal. */
  summary: string;
  /** For the agent: what the skill does and when to use it (frontmatter). */
  description: string;
  /** `SKILL.md` first, then the references in name order. */
  files: SkillFile[];
}

interface SkillMeta {
  title: string;
  summary: string;
  description: string;
}

const metas = import.meta.glob<SkillMeta>("./*/skill.json", { eager: true, import: "default" });
const sources = import.meta.glob<string>("./*/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** Homepage order: the ones listed here first, then the rest by id. */
const ORDER = ["infrawrench-cli", "migrate-github-actions"];

function load(): Skill[] {
  const skills: Skill[] = [];
  for (const [metaPath, meta] of Object.entries(metas)) {
    const id = metaPath.split("/")[1]!;
    const prefix = `./${id}/`;
    const files = Object.entries(sources)
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, content]) => ({ path: p.slice(prefix.length), content: content.trim() + "\n" }))
      .sort((a, b) =>
        a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path),
      );
    if (files[0]?.path !== "SKILL.md") throw new Error(`skill ${id} has no SKILL.md`);
    skills.push({ id, ...meta, files });
  }
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  return skills.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

export const skills: Skill[] = load();

export function getSkill(id: string): Skill | undefined {
  return skills.find((s) => s.id === id);
}

export const SITE = "https://infrawrench.com";

/** Where a skill's file is served: /skills/<id>/<path>. */
export function skillFileUrl(skill: Skill, path: string): string {
  return `${SITE}/skills/${skill.id}/${path}`;
}

/** SKILL.md as Claude Code and the Agent Skills format read it. */
export function skillMd(skill: Skill): string {
  return `---\nname: ${skill.id}\ndescription: ${skill.description}\n---\n\n${skill.files[0]!.content}`;
}

/** The files as written to disk, SKILL.md with its frontmatter. */
export function skillFiles(skill: Skill): SkillFile[] {
  return skill.files.map((f) =>
    f.path === "SKILL.md" ? { path: f.path, content: skillMd(skill) } : f,
  );
}

/**
 * Every file in one document, for harnesses that read a single file per
 * rule. Mentions of `references/x.md` become "the X section below", since
 * the references are appended rather than beside it.
 */
export function skillAsOneFile(skill: Skill): string {
  const [main, ...refs] = skill.files;
  const titleOf = (f: SkillFile) => f.content.match(/^#\s+(.+)$/m)?.[1] ?? f.path;
  let body = main!.content.replaceAll("the files under `references/`", "the sections below");
  for (const ref of refs) {
    body = body.replaceAll(`\`${ref.path}\``, `the "${titleOf(ref)}" section below`);
    body = body.replaceAll(
      `\`${ref.path.replace(/^references\//, "")}\``,
      `the "${titleOf(ref)}" section below`,
    );
  }
  const rest = refs.map((ref) => {
    let text = ref.content;
    for (const other of refs) {
      text = text.replaceAll(
        `\`${other.path.replace(/^references\//, "")}\``,
        `the "${titleOf(other)}" section`,
      );
    }
    return text.replace(/^(#+)/gm, "#$1");
  });
  return [body.trim(), ...rest.map((r) => r.trim())].join("\n\n") + "\n";
}

/** A one-line shell command that installs a skill into Claude Code. */
export function claudeCodeInstall(skill: Skill): string {
  const paths = skill.files.map((f) => f.path).join(" ");
  return `for f in ${paths}; do curl -fsSL --create-dirs -o ".claude/skills/${skill.id}/$f" "${SITE}/skills/${skill.id}/$f"; done\n`;
}
