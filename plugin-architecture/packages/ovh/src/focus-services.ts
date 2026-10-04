import type { FocusCapabilityDeclaration } from "@infrawrench/plugin-base";

/**
 * How OVHcloud bill lines map onto the FOCUS service taxonomy (e.g. `Public
 * Cloud`, `Managed Kubernetes`). Product families before the generic
 * `Public Cloud` catch-all, which covers a project's instances.
 *
 * Read by FOCUS-schema cost exports to fill `ServiceCategory` and
 * `ServiceSubcategory` (FOCUS v1.3 allowed values; the manifest schema rejects
 * a pair that is not). Rules match case-insensitively as substrings of the
 * `service` this plugin writes, first match wins, so specific names come
 * before the general ones that would also match them. A service no rule names
 * falls through to the host's generic keyword classifier, then to `Other`.
 */
export const OVH_FOCUS: FocusCapabilityDeclaration = {
  services: [
    { match: "Kubernetes", category: "Compute", subcategory: "Containers" },
    { match: "Private Registry", category: "Developer Tools", subcategory: "Developer Platforms" },
    { match: "AI Endpoints", category: "AI and Machine Learning", subcategory: "Generative AI" },
    { match: "AI Training", category: "AI and Machine Learning", subcategory: "Machine Learning" },
    { match: "AI Deploy", category: "AI and Machine Learning", subcategory: "Machine Learning" },
    { match: "AI Notebooks", category: "AI and Machine Learning", subcategory: "Machine Learning" },
    { match: "Data Processing", category: "Analytics", subcategory: "Data Processing" },
    { match: "Object Storage", category: "Storage", subcategory: "Object Storage" },
    { match: "Block Storage", category: "Storage", subcategory: "Block Storage" },
    { match: "Cloud Archive", category: "Storage", subcategory: "Backup Storage" },
    { match: "Backup", category: "Storage", subcategory: "Backup Storage" },
    { match: "NAS", category: "Storage", subcategory: "File Storage" },
    { match: "Databases", category: "Databases", subcategory: "Relational Databases" },
    { match: "Web Hosting", category: "Web", subcategory: "Application Platforms" },
    { match: "Load Balancer", category: "Networking", subcategory: "Application Networking" },
    { match: "vRack", category: "Networking", subcategory: "Network Connectivity" },
    { match: "Domain", category: "Networking", subcategory: "Network Routing" },
    { match: "DNS", category: "Networking", subcategory: "Network Routing" },
    {
      match: "Email",
      category: "Business Applications",
      subcategory: "Productivity and Collaboration",
    },
    {
      match: "Exchange",
      category: "Business Applications",
      subcategory: "Productivity and Collaboration",
    },
    {
      match: "Logs Data Platform",
      category: "Management and Governance",
      subcategory: "Observability",
    },
    { match: "Support", category: "Management and Governance", subcategory: "Support" },
    { match: "Public Cloud", category: "Compute", subcategory: "Virtual Machines" },
    { match: "Bare Metal", category: "Compute", subcategory: "Virtual Machines" },
    { match: "Dedicated Server", category: "Compute", subcategory: "Virtual Machines" },
    { match: "VPS", category: "Compute", subcategory: "Virtual Machines" },
    { match: "Hosted Private Cloud", category: "Compute", subcategory: "Virtual Machines" },
  ],
};
