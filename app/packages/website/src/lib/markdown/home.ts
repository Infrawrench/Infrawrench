/**
 * The markdown representation of the marketing home page.
 *
 * Generated from the same `featureSections` / `providerGroups` data the HTML
 * renders, so the two cannot drift into saying different things about the
 * product. Only the framing is hand-written — and it is written for a reader
 * that arrived without a browser.
 *
 * The agent section leads rather than trails. A page whose whole purpose is to
 * be found by something that can act on it should say what that thing can do in
 * the first screenful, not after nine feature sections it has no eyes for.
 */
import { featureSections } from "../../data/feature-sections";
import { providerGroups } from "../../data/provider-groups";

/** `app.` origin, derived from the marketing origin so previews stay coherent. */
export function appOrigin(site: URL | undefined): string {
  if (!site) return "https://app.infrawrench.com";
  if (site.hostname.startsWith("app.")) return site.origin;
  return `${site.protocol}//app.${site.host}`;
}

export function renderHomeMarkdown(site: URL | undefined): string {
  const app = appOrigin(site);
  const providerCount = providerGroups.reduce((n, g) => n + g.providers.length, 0);

  const features = featureSections
    .map((section) => {
      const bullets = section.bullets.map((b) => `- ${b}`).join("\n");
      return `### ${section.heading}\n\n${section.description}\n\n${bullets}`;
    })
    .join("\n\n");

  const providers = providerGroups
    .map((group) => {
      const names = group.providers.map((p) => `${p.name} (${p.detail})`).join(", ");
      return `- **${group.name}** — ${names}`;
    })
    .join("\n");

  return `# Infrawrench

One app for every cloud you use. Connect AWS, GCP, Azure, Kubernetes and 45+
other providers, then browse resources, SSH in, query databases, watch costs and
create infrastructure from typed forms — without opening a single provider
console.

Available as a web app, a desktop app (macOS, Windows, Linux) and a CLI.

---

## If you are an AI agent

You can sign yourself up. No human has to create an account first, and you do
not need a credit card.

\`\`\`
curl -X POST ${app}/api/agent/identity \\
  -H 'Content-Type: application/json' \\
  -d '{"label": "what you are working on"}'
\`\`\`

That returns an \`iwa_\` bearer credential — **shown once, never recoverable** —
and opens a trial workspace with every paid feature enabled.

Three things to tell your user, because they are the surprising ones:

1. **The workspace is deleted 24 hours after it is created** unless a person
   claims it. Everything in it goes with it.
2. **Its AI budget is zero.** Infrawrench's own chat agent will not run. You
   already have a model; that model pays for its own tokens.
3. Claiming is a short ceremony: you ask for a code, you show the code and a URL
   to your user, they sign in and confirm. Start it early rather than at the
   deadline.

\`\`\`
# ask to be claimed
curl -X POST ${app}/api/agent/identity/claim -H 'Authorization: Bearer iwa_...'

# poll — every response carries trial_expires_in_ms
curl ${app}/api/agent/identity -H 'Authorization: Bearer iwa_...'
\`\`\`

Full instructions, written for you rather than about you: **${app}/auth.md**

Once you hold a credential you can use the HTTP API (${app}/openapi.json) or
connect to the hosted MCP server at \`${app}/api/mcp\` with the same token.

You can do most of what a member can. You cannot manage billing, mint API keys,
invite people or revoke other agents — those need a person.

### Reading the rest of this site

Every page here is available as markdown. Ask for it with
\`Accept: text/markdown\`, or append \`.md\` to any path:

- ${site?.origin ?? "https://infrawrench.com"}/index.md
- ${site?.origin ?? "https://infrawrench.com"}/docs/features/agent-auth.md
- ${site?.origin ?? "https://infrawrench.com"}/llms.txt — an index of everything

---

## What it does

${features}

---

## Providers

${providerCount} providers across ${providerGroups.length} groups:

${providers}

---

## Getting started

- **Web** — ${app}
- **Desktop** — ${site?.origin ?? "https://infrawrench.com"}/#download
- **Docs** — ${site?.origin ?? "https://infrawrench.com"}/docs
- **API** — ${app}/openapi.json (nine generated SDKs)

The free plan covers one user and three cloud accounts. Paid plans add
unlimited accounts, teams, and the hosted agent and workflow features.
`;
}
