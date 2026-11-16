import type { APIRoute } from "astro";
import { skillFiles, skills } from "../../../data/skills";

/**
 * `/skills/<id>/<path>`: each file of an agent skill as it goes on disk
 * (`SKILL.md` with its frontmatter, then `references/*.md`), so an agent or
 * the install command on the skill's modal can fetch it.
 */
export const prerender = true;

export function getStaticPaths() {
  return skills.flatMap((skill) =>
    skillFiles(skill).map((file) => ({
      params: { id: skill.id, path: file.path },
      props: { content: file.content },
    })),
  );
}

export const GET: APIRoute = ({ props }) =>
  new Response(props["content"] as string, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
