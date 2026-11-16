import type { APIRoute } from "astro";
import { skillAsOneFile, skills } from "../../data/skills";

/**
 * `/skills/<id>.md`: a skill with its references appended, for an agent that
 * is pointed at one URL instead of installing the folder.
 */
export const prerender = true;

export function getStaticPaths() {
  return skills.map((skill) => ({
    params: { id: skill.id },
    props: { content: skillAsOneFile(skill) },
  }));
}

export const GET: APIRoute = ({ props }) =>
  new Response(props["content"] as string, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
