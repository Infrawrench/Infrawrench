import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifySiteResourceType = rt({
  name: "Site",
  id: "netlify-site",
  description: "A Netlify site — static hosting with CI/CD, serverless functions, and edge network",
  fields: [
    f("name", "Name"),
    f("url", "URL", { required: false }),
    f("sslUrl", "SSL URL", { required: false }),
    f("customDomain", "Custom Domain", { required: false }),
    f("domainAliases", "Domain Aliases", { required: false }),
    f("state", "State", { required: false }),
    f("plan", "Plan", { required: false }),
    f("repoUrl", "Repository", { required: false }),
    f("repoBranch", "Production Branch", { required: false }),
    f("buildCommand", "Build Command", { required: false }),
    f("publishDir", "Publish Directory", { required: false }),
    f("framework", "Framework", { required: false }),
    f("functionsRegion", "Functions Region", { required: false }),
    f("ssl", "SSL", { kind: "boolean", required: false }),
    f("forceSsl", "Force SSL", { kind: "boolean", required: false }),
    f("managedDns", "Managed DNS", { kind: "boolean", required: false }),
    f("accountName", "Team", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("updatedAt", "Updated At", { required: false }),
  ],
  outputs: [
    o("siteId", "Site ID"),
    o("siteName", "Site Name"),
    o("url", "Site URL"),
    o("sslUrl", "SSL URL"),
    o("deployHook", "Deploy Hook URL", { sensitive: true }),
  ],
  // A Netlify DNS zone is identified by its domain name, which the zone lister
  // stores in `name` — the site's domains match against that, not the zone id.
  // `domainAliases` is comma-joined, so each alias becomes its own edge.
  dependsOn: [
    {
      fieldKey: "customDomain",
      targetTypeId: "netlify-dns-zone",
      targetKey: "name",
      label: "in zone",
    },
    {
      fieldKey: "domainAliases",
      targetTypeId: "netlify-dns-zone",
      targetKey: "name",
      label: "in zone",
    },
  ],
  supportsCreate: true,
  iconKey: "site",
  // `<site-name>.netlify.app` (and the legacy `.netlify.com`). The site's
  // `name` is the subdomain; `url`/`sslUrl` are full URLs, which the host
  // reduces to their host before comparing.
  dnsServiceHosts: [
    {
      id: "netlify-subdomain",
      label: "Netlify site subdomain",
      hostPattern: String.raw`([a-z0-9][a-z0-9-]*)\.netlify\.(?:app|com)`,
      hostKeys: ["url", "sslUrl"],
      reason:
        "Deleting or renaming a site frees its subdomain for any Netlify user to claim, and Netlify will serve their deploy under your hostname.",
    },
  ],
  secretExportTemplates: [
    {
      id: "site-url",
      displayName: "Site URL",
      description: "The production URL for this Netlify site",
      entries: [{ envKey: "SITE_URL", outputKey: "sslUrl" }],
    },
    {
      id: "deploy-hook",
      displayName: "Deploy Hook",
      description: "Webhook URL to trigger a new deploy",
      entries: [{ envKey: "NETLIFY_DEPLOY_HOOK", outputKey: "deployHook" }],
    },
  ],
});
