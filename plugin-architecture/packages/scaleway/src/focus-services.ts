import type { FocusCapabilityDeclaration } from "@infrawrench/plugin-base";

/**
 * How Scaleway billing products map onto the FOCUS service taxonomy (e.g.
 * `Kubernetes Kapsule`, `Object Storage`).
 *
 * Read by FOCUS-schema cost exports to fill `ServiceCategory` and
 * `ServiceSubcategory` (FOCUS v1.3 allowed values; the manifest schema rejects
 * a pair that is not). Rules match case-insensitively as substrings of the
 * `service` this plugin writes, first match wins, so specific names come
 * before the general ones that would also match them. A service no rule names
 * falls through to the host's generic keyword classifier, then to `Other`.
 */
export const SCALEWAY_FOCUS: FocusCapabilityDeclaration = {
  services: [
    { match: "Kapsule", category: "Compute", subcategory: "Containers" },
    { match: "Kosmos", category: "Compute", subcategory: "Containers" },
    {
      match: "Container Registry",
      category: "Developer Tools",
      subcategory: "Developer Platforms",
    },
    { match: "Serverless Containers", category: "Compute", subcategory: "Containers" },
    { match: "Serverless Functions", category: "Compute", subcategory: "Serverless Compute" },
    { match: "Serverless Jobs", category: "Compute", subcategory: "Other (Compute)" },
    { match: "Generative APIs", category: "AI and Machine Learning", subcategory: "Generative AI" },
    {
      match: "Managed Inference",
      category: "AI and Machine Learning",
      subcategory: "Machine Learning",
    },
    { match: "Elastic Metal", category: "Compute", subcategory: "Virtual Machines" },
    { match: "Apple silicon", category: "Compute", subcategory: "Virtual Machines" },
    { match: "Instance", category: "Compute", subcategory: "Virtual Machines" },
    { match: "Object Storage", category: "Storage", subcategory: "Object Storage" },
    { match: "Block Storage", category: "Storage", subcategory: "Block Storage" },
    { match: "File Storage", category: "Storage", subcategory: "File Storage" },
    { match: "Glacier", category: "Storage", subcategory: "Backup Storage" },
    { match: "Redis", category: "Databases", subcategory: "Caching" },
    { match: "MongoDB", category: "Databases", subcategory: "NoSQL Databases" },
    {
      match: "Serverless SQL Database",
      category: "Databases",
      subcategory: "Relational Databases",
    },
    { match: "Managed Database", category: "Databases", subcategory: "Relational Databases" },
    { match: "Data Warehouse", category: "Databases", subcategory: "Data Warehouses" },
    { match: "Messaging", category: "Integration", subcategory: "Messaging" },
    { match: "Queues", category: "Integration", subcategory: "Messaging" },
    { match: "Topics and Events", category: "Integration", subcategory: "Messaging" },
    {
      match: "Transactional Email",
      category: "Business Applications",
      subcategory: "Other (Business Applications)",
    },
    { match: "Web Hosting", category: "Web", subcategory: "Application Platforms" },
    { match: "Load Balancer", category: "Networking", subcategory: "Application Networking" },
    { match: "Edge Services", category: "Networking", subcategory: "Content Delivery" },
    { match: "Domains and DNS", category: "Networking", subcategory: "Network Routing" },
    { match: "Public Gateway", category: "Networking", subcategory: "Network Connectivity" },
    { match: "VPC", category: "Networking", subcategory: "Network Infrastructure" },
    { match: "Flexible IP", category: "Networking", subcategory: "Network Infrastructure" },
    { match: "Secret Manager", category: "Security", subcategory: "Secret Management" },
    { match: "Key Manager", category: "Security", subcategory: "Secret Management" },
    { match: "Cockpit", category: "Management and Governance", subcategory: "Observability" },
    { match: "Audit Trail", category: "Management and Governance", subcategory: "Compliance" },
    { match: "Support", category: "Management and Governance", subcategory: "Support" },
  ],
};
