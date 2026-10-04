import type { FocusCapabilityDeclaration } from "@infrawrench/plugin-base";

/**
 * How Google Cloud services map onto the FOCUS service taxonomy. The names
 * are the billing export's `service.description` values (e.g. `Compute
 * Engine`, `BigQuery`).
 *
 * Read by FOCUS-schema cost exports to fill `ServiceCategory` and
 * `ServiceSubcategory` (FOCUS v1.3 allowed values; the manifest schema rejects
 * a pair that is not). Rules match case-insensitively as substrings of the
 * `service` this plugin writes, first match wins, so specific names come
 * before the general ones that would also match them. A service no rule names
 * falls through to the host's generic keyword classifier, then to `Other`.
 */
export const GCP_FOCUS: FocusCapabilityDeclaration = {
  services: [
    { match: "Kubernetes Engine", category: "Compute", subcategory: "Containers" },
    { match: "Cloud Run", category: "Compute", subcategory: "Serverless Compute" },
    { match: "Cloud Functions", category: "Compute", subcategory: "Serverless Compute" },
    { match: "App Engine", category: "Web", subcategory: "Application Platforms" },
    { match: "Firebase Hosting", category: "Web", subcategory: "Application Platforms" },
    { match: "Compute Engine", category: "Compute", subcategory: "Virtual Machines" },
    { match: "VMware Engine", category: "Compute", subcategory: "Virtual Machines" },
    { match: "Backup and DR", category: "Storage", subcategory: "Backup Storage" },
    { match: "Filestore", category: "Storage", subcategory: "File Storage" },
    { match: "Cloud Storage", category: "Storage", subcategory: "Object Storage" },
    { match: "BigQuery", category: "Databases", subcategory: "Data Warehouses" },
    { match: "Cloud SQL", category: "Databases", subcategory: "Relational Databases" },
    { match: "AlloyDB", category: "Databases", subcategory: "Relational Databases" },
    { match: "Spanner", category: "Databases", subcategory: "Relational Databases" },
    { match: "Bigtable", category: "Databases", subcategory: "NoSQL Databases" },
    { match: "Firestore", category: "Databases", subcategory: "NoSQL Databases" },
    { match: "Datastore", category: "Databases", subcategory: "NoSQL Databases" },
    { match: "Firebase Realtime Database", category: "Databases", subcategory: "NoSQL Databases" },
    { match: "Memorystore", category: "Databases", subcategory: "Caching" },
    { match: "Gemini", category: "AI and Machine Learning", subcategory: "Generative AI" },
    { match: "Generative AI", category: "AI and Machine Learning", subcategory: "Generative AI" },
    { match: "Vertex AI", category: "AI and Machine Learning", subcategory: "AI Platforms" },
    { match: "Dialogflow", category: "AI and Machine Learning", subcategory: "Bots" },
    {
      match: "Natural Language",
      category: "AI and Machine Learning",
      subcategory: "Natural Language Processing",
    },
    {
      match: "Speech-to-Text",
      category: "AI and Machine Learning",
      subcategory: "Natural Language Processing",
    },
    {
      match: "Text-to-Speech",
      category: "AI and Machine Learning",
      subcategory: "Natural Language Processing",
    },
    {
      match: "Translation",
      category: "AI and Machine Learning",
      subcategory: "Natural Language Processing",
    },
    { match: "Document AI", category: "AI and Machine Learning", subcategory: "Machine Learning" },
    { match: "Vision", category: "AI and Machine Learning", subcategory: "Machine Learning" },
    {
      match: "Video Intelligence",
      category: "AI and Machine Learning",
      subcategory: "Machine Learning",
    },
    { match: "Cloud TPU", category: "AI and Machine Learning", subcategory: "Machine Learning" },
    { match: "Dataflow", category: "Analytics", subcategory: "Data Processing" },
    { match: "Dataproc", category: "Analytics", subcategory: "Data Processing" },
    { match: "Cloud Composer", category: "Integration", subcategory: "Workflow Orchestration" },
    { match: "Workflows", category: "Integration", subcategory: "Workflow Orchestration" },
    { match: "Cloud Scheduler", category: "Integration", subcategory: "Workflow Orchestration" },
    { match: "Cloud Tasks", category: "Integration", subcategory: "Messaging" },
    { match: "Pub/Sub", category: "Integration", subcategory: "Messaging" },
    { match: "Eventarc", category: "Integration", subcategory: "Messaging" },
    { match: "Apigee", category: "Integration", subcategory: "API Management" },
    { match: "API Gateway", category: "Integration", subcategory: "API Management" },
    { match: "Looker", category: "Analytics", subcategory: "Business Intelligence" },
    { match: "Dataplex", category: "Management and Governance", subcategory: "Data Governance" },
    {
      match: "Data Catalog",
      category: "Management and Governance",
      subcategory: "Data Governance",
    },
    { match: "Cloud CDN", category: "Networking", subcategory: "Content Delivery" },
    { match: "Media CDN", category: "Networking", subcategory: "Content Delivery" },
    { match: "Cloud DNS", category: "Networking", subcategory: "Network Routing" },
    { match: "Load Balancing", category: "Networking", subcategory: "Application Networking" },
    { match: "Cloud Interconnect", category: "Networking", subcategory: "Network Connectivity" },
    { match: "Cloud VPN", category: "Networking", subcategory: "Network Connectivity" },
    { match: "Cloud NAT", category: "Networking", subcategory: "Network Connectivity" },
    { match: "Cloud Armor", category: "Networking", subcategory: "Network Security" },
    { match: "Networking", category: "Networking", subcategory: "Network Infrastructure" },
    {
      match: "Security Command Center",
      category: "Security",
      subcategory: "Security Posture Management",
    },
    { match: "Secret Manager", category: "Security", subcategory: "Secret Management" },
    { match: "Key Management Service", category: "Security", subcategory: "Secret Management" },
    { match: "Cloud KMS", category: "Security", subcategory: "Secret Management" },
    {
      match: "Identity Platform",
      category: "Identity",
      subcategory: "Identity and Access Management",
    },
    {
      match: "Identity-Aware Proxy",
      category: "Identity",
      subcategory: "Identity and Access Management",
    },
    { match: "Cloud Logging", category: "Management and Governance", subcategory: "Observability" },
    {
      match: "Cloud Monitoring",
      category: "Management and Governance",
      subcategory: "Observability",
    },
    { match: "Stackdriver", category: "Management and Governance", subcategory: "Observability" },
    { match: "Cloud Trace", category: "Management and Governance", subcategory: "Observability" },
    { match: "Support", category: "Management and Governance", subcategory: "Support" },
    { match: "Artifact Registry", category: "Developer Tools", subcategory: "Developer Platforms" },
    {
      match: "Container Registry",
      category: "Developer Tools",
      subcategory: "Developer Platforms",
    },
    {
      match: "Cloud Build",
      category: "Developer Tools",
      subcategory: "Continuous Integration and Deployment",
    },
    {
      match: "Cloud Deploy",
      category: "Developer Tools",
      subcategory: "Continuous Integration and Deployment",
    },
    {
      match: "Cloud Workstations",
      category: "Developer Tools",
      subcategory: "Development Environments",
    },
    {
      match: "Source Repositories",
      category: "Developer Tools",
      subcategory: "Source Code Management",
    },
    { match: "Transcoder", category: "Media", subcategory: "Content Creation" },
    { match: "Database Migration", category: "Migration", subcategory: "Data Migration" },
    { match: "Storage Transfer", category: "Migration", subcategory: "Data Migration" },
    { match: "Migrate to", category: "Migration", subcategory: "Resource Migration" },
  ],
};
