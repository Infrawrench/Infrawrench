import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifySiteResourceType = rt({
  name: "Site",
  id: "netlify-site",
  description:
    "A Netlify project (formerly site): static hosting with CI/CD, serverless functions, and edge network",
  fields: [
    f("name", "Name", { description: "Also the <name>.netlify.app subdomain" }),
    f("url", "URL", { required: false, editable: false }),
    f("sslUrl", "SSL URL", { required: false, editable: false }),
    f("customDomain", "Custom Domain", { required: false, editable: false }),
    f("domainAliases", "Domain Aliases", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("repoUrl", "Repository", { required: false, editable: false }),
    f("repoBranch", "Production Branch", { required: false }),
    f("buildCommand", "Build Command", { required: false }),
    f("publishDir", "Publish Directory", { required: false }),
    f("functionsDir", "Functions Directory", { required: false }),
    f("stopBuilds", "Builds Stopped", {
      kind: "boolean",
      required: false,
      description: "Stop automatic builds from Git pushes",
    }),
    f("framework", "Framework", { required: false, editable: false }),
    f("functionsRegion", "Functions Region", { required: false, editable: false }),
    f("ssl", "SSL", { kind: "boolean", required: false, editable: false }),
    f("forceSsl", "Force SSL", {
      kind: "boolean",
      required: false,
      description: "Redirect HTTP requests to HTTPS",
    }),
    f("managedDns", "Managed DNS", { kind: "boolean", required: false, editable: false }),
    f("accountName", "Team", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
  ],
  outputs: [
    o("siteId", "Site ID"),
    o("siteName", "Site Name"),
    o("url", "Site URL"),
    o("sslUrl", "SSL URL"),
    o("deployHook", "Deploy Hook URL", { sensitive: true }),
  ],
  // A Netlify DNS zone is identified by its domain name, which the zone lister
  // stores in `name`: the site's domains match against that, not the zone id.
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
  supportsUpdate: true,
  iconKey: "site",
  // `<site-name>.netlify.app` (and the legacy `.netlify.com`), plus branch /
  // deploy-preview aliases of the form `<branch>--<site-name>.netlify.app`.
  // Capture group 1 is always the site name so the existing `name` claimant
  // resolves them. `url`/`sslUrl` are full URLs, reduced to their host before
  // comparing.
  dnsServiceHosts: [
    {
      id: "netlify-subdomain",
      label: "Netlify site subdomain",
      hostPattern: String.raw`(?:[a-z0-9][a-z0-9-]*--)?([a-z0-9][a-z0-9-]*)\.netlify\.(?:app|com)`,
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
