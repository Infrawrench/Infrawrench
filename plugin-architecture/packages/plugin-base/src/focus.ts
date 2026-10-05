/**
 * FOCUS service classification.
 *
 * FOCUS (the FinOps Open Cost and Usage Specification) requires every row of a
 * cost dataset to carry a `ServiceCategory` drawn from a fixed list, and
 * recommends a `ServiceSubcategory` drawn from a second fixed list in which
 * every subcategory has exactly one parent. Both lists below are copied from
 * the v1.3 specification
 * (https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec/tree/v1.3,
 * `columns/servicecategory.md` and `columns/servicesubcategory.md`) and must
 * only ever change alongside a specification version bump: a value outside
 * them makes the whole file non-conformant.
 *
 * Classifying a service is provider knowledge ("is `Workers` compute?"), so it
 * belongs to plugins: {@link FocusCapabilityDeclaration} on a plugin's
 * `manifest.costs.focus` is how a plugin states it. What lives here is the
 * generic part: the allowed values, and {@link classifyFocusService}, a
 * keyword fallback the host uses for a service no plugin classified. The
 * fallback only knows generic English terms ("database", "storage", "load
 * balancer"); a provider's product names go in that provider's plugin.
 */

/** `ServiceCategory` allowed values, FOCUS v1.3, in specification order. */
export const FOCUS_SERVICE_CATEGORIES = [
  "AI and Machine Learning",
  "Analytics",
  "Business Applications",
  "Compute",
  "Databases",
  "Developer Tools",
  "Multicloud",
  "Identity",
  "Integration",
  "Internet of Things",
  "Management and Governance",
  "Media",
  "Migration",
  "Mobile",
  "Networking",
  "Security",
  "Storage",
  "Web",
  "Other",
] as const;
export type FocusServiceCategory = (typeof FOCUS_SERVICE_CATEGORIES)[number];

/**
 * `ServiceSubcategory` allowed values, FOCUS v1.3, keyed by their one parent.
 * Every category ends in its own `Other (<category>)` member, which is what a
 * service with no closer fit is recorded as.
 */
export const FOCUS_SERVICE_SUBCATEGORIES = {
  "AI and Machine Learning": [
    "AI Platforms",
    "Bots",
    "Generative AI",
    "Machine Learning",
    "Natural Language Processing",
    "Other (AI and Machine Learning)",
  ],
  Analytics: [
    "Analytics Platforms",
    "Business Intelligence",
    "Data Processing",
    "Search",
    "Streaming Analytics",
    "Other (Analytics)",
  ],
  "Business Applications": ["Productivity and Collaboration", "Other (Business Applications)"],
  Compute: [
    "Containers",
    "End User Computing",
    "Quantum Compute",
    "Serverless Compute",
    "Virtual Machines",
    "Other (Compute)",
  ],
  Databases: [
    "Caching",
    "Data Warehouses",
    "Ledger Databases",
    "NoSQL Databases",
    "Relational Databases",
    "Time Series Databases",
    "Other (Databases)",
  ],
  "Developer Tools": [
    "Developer Platforms",
    "Continuous Integration and Deployment",
    "Development Environments",
    "Source Code Management",
    "Quality Assurance",
    "Other (Developer Tools)",
  ],
  Multicloud: ["Multicloud Integration", "Other (Multicloud)"],
  Identity: ["Identity and Access Management", "Other (Identity)"],
  Integration: ["API Management", "Messaging", "Workflow Orchestration", "Other (Integration)"],
  "Internet of Things": ["IoT Analytics", "IoT Platforms", "Other (Internet of Things)"],
  "Management and Governance": [
    "Architecture",
    "Compliance",
    "Cost Management",
    "Data Governance",
    "Disaster Recovery",
    "Endpoint Management",
    "Observability",
    "Support",
    "Other (Management and Governance)",
  ],
  Media: ["Content Creation", "Gaming", "Media Streaming", "Mixed Reality", "Other (Media)"],
  Migration: ["Data Migration", "Resource Migration", "Other (Migration)"],
  Mobile: ["Other (Mobile)"],
  Networking: [
    "Application Networking",
    "Content Delivery",
    "Network Connectivity",
    "Network Infrastructure",
    "Network Routing",
    "Network Security",
    "Other (Networking)",
  ],
  Security: [
    "Secret Management",
    "Security Posture Management",
    "Threat Detection and Response",
    "Other (Security)",
  ],
  Storage: [
    "Backup Storage",
    "Block Storage",
    "File Storage",
    "Object Storage",
    "Storage Platforms",
    "Other (Storage)",
  ],
  Web: ["Application Platforms", "Other (Web)"],
  Other: ["Other (Other)"],
} as const satisfies Record<FocusServiceCategory, readonly string[]>;

/** Every `ServiceSubcategory` value, as a union. */
export type FocusServiceSubcategory =
  (typeof FOCUS_SERVICE_SUBCATEGORIES)[FocusServiceCategory][number];

/**
 * One service's place in the FOCUS taxonomy. `subcategory` must be a child of
 * `category`; the manifest schema rejects a mismatched pair, and so does
 * {@link isValidFocusClassification} for anything computed at runtime.
 */
export interface FocusServiceClassification {
  category: FocusServiceCategory;
  subcategory: FocusServiceSubcategory;
}

/**
 * How a plugin classifies the services it bills, for FOCUS-schema exports.
 *
 * Declarative on purpose (no callbacks): manifests are data that cross process
 * and serialization boundaries, and a rule list is also something a reviewer
 * can read against the provider's product catalogue.
 */
export interface FocusCapabilityDeclaration {
  /**
   * Rules tried in order against the row's `service`; the first whose `match`
   * occurs in it (case-insensitively) wins. Write the specific rule before the
   * general one: `"Elastic Container Registry"` before `"Container"`.
   */
  services?: Array<FocusServiceClassification & { match: string }>;
  /**
   * What a service no rule matched is. Set it for single-purpose providers (an
   * LLM API is "AI and Machine Learning" whatever its line items are called);
   * leave it unset for a broad catalogue, where the host's generic keyword
   * fallback ({@link classifyFocusService}) is a better guess than any one
   * default.
   */
  default?: FocusServiceClassification;
}

/** Whether `subcategory` is one of `category`'s children. */
export function isValidFocusClassification(c: {
  category: string;
  subcategory: string;
}): c is FocusServiceClassification {
  const children = (FOCUS_SERVICE_SUBCATEGORIES as Record<string, readonly string[]>)[c.category];
  return !!children && children.includes(c.subcategory);
}

/** The `Other (<category>)` subcategory every category has. */
export function otherFocusSubcategory(category: FocusServiceCategory): FocusServiceSubcategory {
  return `Other (${category})` as FocusServiceSubcategory;
}

/**
 * Generic keyword rules, most specific first. Every term is a plain English
 * word or an industry-wide acronym; nothing names one provider's product.
 * Matched as whole words (or word prefixes where the stem is listed) against
 * the lower-cased service name.
 */
const GENERIC_RULES: ReadonlyArray<readonly [RegExp, FocusServiceClassification]> = [
  [/\bsupport\b/, { category: "Management and Governance", subcategory: "Support" }],
  [
    /\b(cost|billing|budget)s?\b/,
    { category: "Management and Governance", subcategory: "Cost Management" },
  ],
  [
    /\b(monitor\w*|logs?|logging|metrics?|tracing|observability|telemetry|apm)\b/,
    { category: "Management and Governance", subcategory: "Observability" },
  ],
  [/\b(backups?|snapshots?|archive)\b/, { category: "Storage", subcategory: "Backup Storage" }],
  [
    /\b(secrets?|vault|kms|key management)\b/,
    { category: "Security", subcategory: "Secret Management" },
  ],
  [/\b(firewall|waf|ddos|shield)\b/, { category: "Networking", subcategory: "Network Security" }],
  [
    /\b(threat|guard\w*|intrusion|siem)\b/,
    { category: "Security", subcategory: "Threat Detection and Response" },
  ],
  [
    /\b(security|compliance|posture)\b/,
    { category: "Security", subcategory: "Security Posture Management" },
  ],
  [
    /\b(identity|iam|directory|sso|auth\w*|users?)\b/,
    { category: "Identity", subcategory: "Identity and Access Management" },
  ],
  [
    /\b(llm|generative|gpt|chat|completions?|tokens?|embeddings?|text to speech|speech to text|tts|stt|transcri\w*|voice)\b/,
    { category: "AI and Machine Learning", subcategory: "Generative AI" },
  ],
  [
    /\b(ai|ml|machine learning|inference|models?|training|fine.?tun\w*)\b/,
    { category: "AI and Machine Learning", subcategory: "Machine Learning" },
  ],
  [/\b(gpus?)\b/, { category: "Compute", subcategory: "Virtual Machines" }],
  [/\b(warehouse|olap)\b/, { category: "Databases", subcategory: "Data Warehouses" }],
  [
    /\b(cache|caching|redis|memcached?|valkey)\b/,
    { category: "Databases", subcategory: "Caching" },
  ],
  [/\b(time.?series)\b/, { category: "Databases", subcategory: "Time Series Databases" }],
  [
    /\b(nosql|document|mongo\w*|key.?value)\b/,
    { category: "Databases", subcategory: "NoSQL Databases" },
  ],
  [
    /\b(databases?|sql|postgres\w*|mysql|mariadb|relational)\b/,
    { category: "Databases", subcategory: "Relational Databases" },
  ],
  [/\b(search)\b/, { category: "Analytics", subcategory: "Search" }],
  [
    /\b(stream\w* analytics|kafka)\b/,
    { category: "Analytics", subcategory: "Streaming Analytics" },
  ],
  [
    /\b(analytics|etl|data processing|spark|query)\b/,
    { category: "Analytics", subcategory: "Data Processing" },
  ],
  [
    /\b(queues?|messag\w*|pub.?sub|notifications?|events?)\b/,
    { category: "Integration", subcategory: "Messaging" },
  ],
  [/\b(api gateway|apis?)\b/, { category: "Integration", subcategory: "API Management" }],
  [
    /\b(workflows?|orchestrat\w*|scheduler)\b/,
    { category: "Integration", subcategory: "Workflow Orchestration" },
  ],
  [
    /\b(e.?mail|sms)\b/,
    { category: "Business Applications", subcategory: "Other (Business Applications)" },
  ],
  [
    /\b(registry|registries)\b/,
    { category: "Developer Tools", subcategory: "Developer Platforms" },
  ],
  [
    /\b(builds?|ci|cd|pipelines?|deploy\w*)\b/,
    { category: "Developer Tools", subcategory: "Continuous Integration and Deployment" },
  ],
  [
    /\b(repositor\w*|git)\b/,
    { category: "Developer Tools", subcategory: "Source Code Management" },
  ],
  [
    /\b(cdn|content delivery|edge cach\w*)\b/,
    { category: "Networking", subcategory: "Content Delivery" },
  ],
  [/\b(dns|domains?|routing)\b/, { category: "Networking", subcategory: "Network Routing" }],
  [/\b(load.?balanc\w*)\b/, { category: "Networking", subcategory: "Application Networking" }],
  [
    /\b(vpn|interconnect|peering|nat|gateway|private link|tunnel\w*)\b/,
    { category: "Networking", subcategory: "Network Connectivity" },
  ],
  [
    /\b(network\w*|bandwidth|egress|ingress|data transfer|traffic|ips?|ipv4|ipv6|vpc)\b/,
    { category: "Networking", subcategory: "Network Infrastructure" },
  ],
  [/\b(object|buckets?|blob)\b/, { category: "Storage", subcategory: "Object Storage" }],
  [/\b(block|volumes?|disks?)\b/, { category: "Storage", subcategory: "Block Storage" }],
  [/\b(file|files|nfs|smb)\b/, { category: "Storage", subcategory: "File Storage" }],
  [/\b(storage)\b/, { category: "Storage", subcategory: "Other (Storage)" }],
  [
    /\b(kubernetes|containers?|k8s|pods?|namespaces?)\b/,
    { category: "Compute", subcategory: "Containers" },
  ],
  [
    /\b(functions?|serverless|workers?)\b/,
    { category: "Compute", subcategory: "Serverless Compute" },
  ],
  [/\b(desktops?|workspaces?)\b/, { category: "Compute", subcategory: "End User Computing" }],
  [
    /\b(virtual machines?|vms?|instances?|servers?|droplets?|compute|cpu|vcpu|hosts?)\b/,
    { category: "Compute", subcategory: "Virtual Machines" },
  ],
  [
    /\b(video|images?|media|transcod\w*|stream\w*)\b/,
    { category: "Media", subcategory: "Other (Media)" },
  ],
  [/\b(iot|devices?)\b/, { category: "Internet of Things", subcategory: "IoT Platforms" }],
  [/\b(migrat\w*)\b/, { category: "Migration", subcategory: "Other (Migration)" }],
  [/\b(hosting|web|sites?|apps?)\b/, { category: "Web", subcategory: "Application Platforms" }],
];

/** `Other` / `Other (Other)`: what FOCUS says to use when nothing fits. */
export const FOCUS_OTHER_CLASSIFICATION: FocusServiceClassification = {
  category: "Other",
  subcategory: "Other (Other)",
};

/**
 * Classify a service by generic keywords. Returns `undefined` when nothing
 * matched, so a caller can tell "the fallback guessed" from "nobody knows";
 * the host maps the latter onto {@link FOCUS_OTHER_CLASSIFICATION}.
 */
export function classifyFocusService(service: string): FocusServiceClassification | undefined {
  const name = service.toLowerCase().replace(/[_\-/]+/g, " ");
  if (!name.trim()) return undefined;
  for (const [pattern, classification] of GENERIC_RULES) {
    if (pattern.test(name)) return classification;
  }
  return undefined;
}

/**
 * Resolve one service against a plugin's declaration, then the generic
 * keywords, then `Other`. Always returns a valid pair: a declaration whose
 * pair is mismatched (which the manifest schema should already have refused)
 * is skipped rather than written into a file that would then fail validation.
 */
export function resolveFocusService(
  service: string,
  declaration: FocusCapabilityDeclaration | undefined,
): FocusServiceClassification {
  const lower = service.toLowerCase();
  for (const rule of declaration?.services ?? []) {
    if (
      rule.match &&
      lower.includes(rule.match.toLowerCase()) &&
      isValidFocusClassification(rule)
    ) {
      return { category: rule.category, subcategory: rule.subcategory };
    }
  }
  const generic = classifyFocusService(service);
  if (declaration?.default && isValidFocusClassification(declaration.default)) {
    // A single-purpose provider's default beats a generic keyword guess: an
    // LLM vendor's "Batch API" line is AI spend, not a workflow orchestrator.
    return declaration.default;
  }
  return generic ?? FOCUS_OTHER_CLASSIFICATION;
}
