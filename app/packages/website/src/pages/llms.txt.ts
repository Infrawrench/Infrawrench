import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { appOrigin } from "../lib/markdown/home";
import { docMarkdownPath } from "../lib/markdown/docs";

/**
 * `/llms.txt` — the index an agent reads first.
 *
 * Same job `robots.txt` does for crawlers and `sitemap.xml` does for search:
 * one well-known path that says what is here and where the machine-readable
 * version of it lives. It exists because the interesting pages on this site are
 * prerendered and cannot answer an `Accept` header, so discovery has to be a
 * document rather than a protocol.
 *
 * The agent-signup section is first on purpose. Everything below it is reading
 * material; that part is the one thing on this site an agent can *act* on, and
 * burying it under a table of contents would waste the trip.
 */
export const prerender = true;

const SECTION_ORDER = [
  "getting-started",
  "core-concepts",
  "features",
  "plugins",
  "team-and-billing",
];

function sectionOf(id: string): string {
  return id.includes("/") ? (id.split("/")[0] ?? "") : "";
}

export const GET: APIRoute = async ({ site }) => {
  const origin = site?.origin ?? "https://infrawrench.com";
  const app = appOrigin(site);
  const entries = await getCollection("docs");

  const bySection = new Map<string, typeof entries>();
  for (const entry of entries) {
    const section = sectionOf(entry.id);
    const list = bySection.get(section) ?? [];
    list.push(entry);
    bySection.set(section, list);
  }

  const sections = [...bySection.keys()].sort((a, b) => {
    const ai = SECTION_ORDER.indexOf(a);
    const bi = SECTION_ORDER.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b);
  });

  const docs = sections
    .map((section) => {
      const heading = section
        ? section.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())
        : "Overview";
      const items = (bySection.get(section) ?? [])
        .sort((a, b) => (a.data.sidebar_order ?? 99) - (b.data.sidebar_order ?? 99))
        .map((e) => {
          const suffix = e.data.description ? `: ${e.data.description}` : "";
          return `- [${e.data.title}](${origin}${docMarkdownPath(e.id)})${suffix}`;
        })
        .join("\n");
      return `## ${heading}\n\n${items}`;
    })
    .join("\n\n");

  const body = `# Infrawrench

> One app for every cloud you use — AWS, GCP, Azure, Kubernetes and 45+ more.
> Browse resources, SSH in, query databases, watch costs, and create
> infrastructure from typed forms. Web, desktop and CLI.

Every page on this site is available as markdown: send \`Accept: text/markdown\`,
or append \`.md\` to any path.

## Sign yourself up

If you are an agent, you can register without a human creating an account
first, and without a credit card:

\`\`\`
curl -X POST ${app}/api/agent/identity -H 'Content-Type: application/json' -d '{}'
\`\`\`

This opens a trial workspace with every paid feature enabled. It is **deleted
24 hours after it is created** unless a person claims it, and its AI budget is
zero — bring your own model. Tell your user both things.

- [Agent instructions](${app}/auth.md): the full flow, with curl, written for agents
- [Agent authentication](${origin}/docs/features/agent-auth.md): the same thing explained for people
- [HTTP API](${app}/openapi.json): OpenAPI 3.1, nine generated SDKs
- [MCP server](${origin}/docs/features/mcp.md): hosted at \`${app}/api/mcp\`

## Start here

- [Home](${origin}/index.md): what Infrawrench is, and the provider list
- [Documentation](${origin}/docs): rendered HTML index

${docs}
`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
