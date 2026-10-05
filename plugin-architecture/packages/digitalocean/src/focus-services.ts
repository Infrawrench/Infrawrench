import type { FocusCapabilityDeclaration } from "@infrawrench/plugin-base";

/**
 * How DigitalOcean invoice items map onto the FOCUS service taxonomy (e.g.
 * `Droplets`, `Spaces Subscription`, `Managed Databases`).
 *
 * Read by FOCUS-schema cost exports to fill `ServiceCategory` and
 * `ServiceSubcategory` (FOCUS v1.3 allowed values; the manifest schema rejects
 * a pair that is not). Rules match case-insensitively as substrings of the
 * `service` this plugin writes, first match wins, so specific names come
 * before the general ones that would also match them. A service no rule names
 * falls through to the host's generic keyword classifier, then to `Other`.
 */
export const DIGITALOCEAN_FOCUS: FocusCapabilityDeclaration = {
  services: [
    { match: "Kubernetes", category: "Compute", subcategory: "Containers" },
    {
      match: "Container Registry",
      category: "Developer Tools",
      subcategory: "Developer Platforms",
    },
    { match: "App Platform", category: "Web", subcategory: "Application Platforms" },
    { match: "Functions", category: "Compute", subcategory: "Serverless Compute" },
    { match: "Droplet", category: "Compute", subcategory: "Virtual Machines" },
    { match: "Spaces", category: "Storage", subcategory: "Object Storage" },
    { match: "Volume", category: "Storage", subcategory: "Block Storage" },
    { match: "Snapshot", category: "Storage", subcategory: "Backup Storage" },
    { match: "Backup", category: "Storage", subcategory: "Backup Storage" },
    { match: "Database", category: "Databases", subcategory: "Relational Databases" },
    { match: "GenAI", category: "AI and Machine Learning", subcategory: "Generative AI" },
    { match: "Load Balancer", category: "Networking", subcategory: "Application Networking" },
    { match: "Reserved IP", category: "Networking", subcategory: "Network Infrastructure" },
    { match: "Floating IP", category: "Networking", subcategory: "Network Infrastructure" },
    { match: "Bandwidth", category: "Networking", subcategory: "Network Infrastructure" },
    { match: "Monitoring", category: "Management and Governance", subcategory: "Observability" },
    { match: "Uptime", category: "Management and Governance", subcategory: "Observability" },
    { match: "Support", category: "Management and Governance", subcategory: "Support" },
  ],
};
