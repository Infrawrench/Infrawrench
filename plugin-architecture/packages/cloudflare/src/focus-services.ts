import type { FocusCapabilityDeclaration } from "@infrawrench/plugin-base";

/**
 * How Cloudflare subscriptions map onto the FOCUS service taxonomy. The names
 * are the billing history's `ServiceName` values (e.g. `Workers Paid`, `R2`).
 *
 * Read by FOCUS-schema cost exports to fill `ServiceCategory` and
 * `ServiceSubcategory` (FOCUS v1.3 allowed values; the manifest schema rejects
 * a pair that is not). Rules match case-insensitively as substrings of the
 * `service` this plugin writes, first match wins, so specific names come
 * before the general ones that would also match them. A service no rule names
 * falls through to the host's generic keyword classifier, then to `Other`.
 */
export const CLOUDFLARE_FOCUS: FocusCapabilityDeclaration = {
  services: [
    { match: "Workers KV", category: "Databases", subcategory: "NoSQL Databases" },
    { match: "Durable Objects", category: "Compute", subcategory: "Serverless Compute" },
    { match: "Workers AI", category: "AI and Machine Learning", subcategory: "Generative AI" },
    { match: "AI Gateway", category: "AI and Machine Learning", subcategory: "AI Platforms" },
    { match: "Vectorize", category: "Databases", subcategory: "Other (Databases)" },
    { match: "Hyperdrive", category: "Databases", subcategory: "Caching" },
    { match: "D1", category: "Databases", subcategory: "Relational Databases" },
    { match: "Workers", category: "Compute", subcategory: "Serverless Compute" },
    { match: "Pages", category: "Web", subcategory: "Application Platforms" },
    { match: "Containers", category: "Compute", subcategory: "Containers" },
    { match: "R2", category: "Storage", subcategory: "Object Storage" },
    { match: "Queues", category: "Integration", subcategory: "Messaging" },
    { match: "Workflows", category: "Integration", subcategory: "Workflow Orchestration" },
    { match: "Images", category: "Media", subcategory: "Content Creation" },
    { match: "Stream", category: "Media", subcategory: "Media Streaming" },
    { match: "Calls", category: "Media", subcategory: "Media Streaming" },
    { match: "Argo", category: "Networking", subcategory: "Network Routing" },
    { match: "Load Balancing", category: "Networking", subcategory: "Application Networking" },
    { match: "Spectrum", category: "Networking", subcategory: "Application Networking" },
    { match: "Magic Transit", category: "Networking", subcategory: "Network Security" },
    { match: "Magic WAN", category: "Networking", subcategory: "Network Connectivity" },
    { match: "Zero Trust", category: "Security", subcategory: "Security Posture Management" },
    { match: "Access", category: "Identity", subcategory: "Identity and Access Management" },
    { match: "Bot Management", category: "Networking", subcategory: "Network Security" },
    { match: "Rate Limiting", category: "Networking", subcategory: "Network Security" },
    { match: "WAF", category: "Networking", subcategory: "Network Security" },
    { match: "Registrar", category: "Networking", subcategory: "Network Routing" },
    { match: "DNS", category: "Networking", subcategory: "Network Routing" },
    {
      match: "Email",
      category: "Business Applications",
      subcategory: "Other (Business Applications)",
    },
    { match: "Logpush", category: "Management and Governance", subcategory: "Observability" },
    { match: "Plan", category: "Networking", subcategory: "Content Delivery" },
  ],
};
