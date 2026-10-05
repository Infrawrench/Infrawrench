import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";
import { ELASTIC_DEPLOYMENT_EXTENDED_SUPPORT } from "./extended-support.js";

/**
 * Elastic Cloud resource types. Each names the endpoint it lists from; field
 * names follow Elastic's published OpenAPI documents (2026-10).
 */

/** `GET /api/v1/organizations`, enriched by the v1 costs overview. */
export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "An Elastic Cloud organization the API key belongs to. Shows month-to-date spend, the current hourly rate, the prepaid ECU balance, spend by deployment and project, and charts daily cost.",
  fields: [
    f("name", "Name", { editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("monthToDate", "Month-to-Date Cost (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("hourlyRate", "Hourly Rate (USD)", { kind: "number", required: false, editable: false }),
    f("prepaidRemaining", "Prepaid ECUs Remaining", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("billingContacts", "Billing Contacts", { required: false, editable: false }),
  ],
  outputs: [o("organizationId", "Organization ID")],
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "account",
});

/** `GET /api/v1/deployments`, then `GET /api/v1/deployments/{id}` per deployment. */
export const DeploymentResourceType = rt({
  name: "Hosted Deployment",
  id: "deployment",
  description:
    "An Elastic Cloud Hosted deployment: Elasticsearch with Kibana and optional Integrations Server. Rename it, edit its tags, resize the hot tier, restart Elasticsearch or Kibana, apply or remove traffic filters, and chart its daily cost. Deleting shuts the deployment down.",
  fields: [
    f("name", "Name"),
    f("tags", "Tags", {
      required: false,
      description: "Comma-separated key:value pairs, for example team:search, env:prod.",
    }),
    f("hotSizeGb", "Hot Tier Size (GB RAM per zone)", {
      kind: "number",
      required: false,
      description:
        "Memory per zone for the hot (data_hot/data_content) tier. Must be one of the sizes Elastic Cloud offers for the deployment's hardware profile; the detail page lists them.",
    }),
    f("hotZones", "Hot Tier Availability Zones", {
      kind: "enum",
      required: false,
      enumValues: ["1", "2", "3"],
    }),
    f("version", "Version", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("healthy", "Healthy", { kind: "boolean", required: false, editable: false }),
    f("alias", "Alias", { required: false, editable: false }),
    f("template", "Hardware Profile", { required: false, editable: false }),
    f("totalMemoryGb", "Total Memory (GB)", { kind: "number", required: false, editable: false }),
    f("autoscaling", "Autoscaling", { kind: "boolean", required: false, editable: false }),
    f("solution", "Solution", { required: false, editable: false }),
    f("trafficFilterIds", "Traffic Filters", { required: false, editable: false }),
    f("esEndpoint", "Elasticsearch Endpoint", { required: false, editable: false }),
    f("kibanaUrl", "Kibana URL", { required: false, editable: false }),
    f("deploymentId", "Deployment ID", { required: false, editable: false }),
  ],
  outputs: [
    o("esEndpoint", "Elasticsearch Endpoint"),
    o("kibanaUrl", "Kibana URL"),
    o("cloudId", "Cloud ID"),
    o("deploymentId", "Deployment ID"),
  ],
  dependsOn: [
    { fieldKey: "trafficFilterIds", targetTypeId: "traffic-filter", label: "filtered by" },
  ],
  extendedSupport: ELASTIC_DEPLOYMENT_EXTENDED_SUPPORT,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "database",
});

/** `GET /api/v1/serverless/projects/{type}` for each project type. */
export const ProjectResourceType = rt({
  name: "Serverless Project",
  id: "project",
  description:
    "An Elastic Cloud Serverless project (Elasticsearch, Observability, Security or Vector Database). Create one in a region you pick, rename it, adjust search power, edit its tags, reset its admin credentials, resume a suspended project, and chart its daily cost.",
  fields: [
    f("name", "Name"),
    f("searchPower", "Search Power", {
      kind: "number",
      required: false,
      description:
        "Elasticsearch and Vector Database projects only: how fast searches run against your data, from 28 to 3000. Higher values cost more.",
    }),
    f("tags", "Tags", {
      required: false,
      description:
        "Comma-separated key:value pairs. Keys start with a lowercase letter and use only a-z, 0-9, _ and -.",
    }),
    f("projectType", "Type", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("phase", "Status", { required: false, editable: false }),
    f("alias", "Alias", { required: false, editable: false }),
    f("optimizedFor", "Optimized For", { required: false, editable: false }),
    f("productTier", "Product Tier", { required: false, editable: false }),
    f("esEndpoint", "Elasticsearch Endpoint", { required: false, editable: false }),
    f("kibanaUrl", "Kibana URL", { required: false, editable: false }),
    f("trafficFilterIds", "Traffic Filters", { required: false, editable: false }),
    f("suspendedReason", "Suspended Reason", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
  ],
  outputs: [
    o("esEndpoint", "Elasticsearch Endpoint"),
    o("kibanaUrl", "Kibana URL"),
    o("cloudId", "Cloud ID"),
    o("username", "Admin Username"),
    o("password", "Admin Password", { sensitive: true }),
    o("projectId", "Project ID"),
  ],
  dependsOn: [
    {
      fieldKey: "trafficFilterIds",
      targetTypeId: "serverless-traffic-filter",
      label: "filtered by",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "database",
});

/** `GET /api/v1/deployments/traffic-filter/rulesets?include_associations=true`. */
export const TrafficFilterResourceType = rt({
  name: "Traffic Filter",
  id: "traffic-filter",
  description:
    "A hosted-deployment traffic filter ruleset: IP allowlists and private connectivity (AWS PrivateLink, Azure Private Link, GCP Private Service Connect). Create IP filters, edit the name, description, sources and default inclusion, and apply or remove it on deployments.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("sources", "Sources", {
      required: false,
      description:
        "Comma-separated IP addresses or CIDR ranges (IP filters), or endpoint IDs (private connectivity filters).",
    }),
    f("includeByDefault", "Apply to New Deployments", { kind: "boolean", required: false }),
    f("filterType", "Type", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("deploymentIds", "Deployments", { required: false, editable: false }),
    f("associationCount", "Associations", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("rulesetId", "Ruleset ID")],
  dependsOn: [{ fieldKey: "deploymentIds", targetTypeId: "deployment", label: "applied to" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

/** `GET /api/v1/serverless/traffic-filters`. */
export const ServerlessTrafficFilterResourceType = rt({
  name: "Serverless Traffic Filter",
  id: "serverless-traffic-filter",
  description:
    "A traffic filter for serverless projects: an IP allowlist or a private connectivity endpoint in one region. Create IP filters, and edit the name, description, sources and default inclusion.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("sources", "Sources", {
      required: false,
      description: "Comma-separated IP addresses, CIDR ranges or endpoint IDs.",
    }),
    f("includeByDefault", "Apply to New Projects", { kind: "boolean", required: false }),
    f("filterType", "Type", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
  ],
  outputs: [o("filterId", "Filter ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

/** `GET /api/v1/deployments/extensions`. */
export const ExtensionResourceType = rt({
  name: "Extension",
  id: "extension",
  description:
    "A custom Elasticsearch plugin or bundle (scripts, dictionaries, synonyms) available to hosted deployments. Register one from a download URL, edit its name, description, version or URL, and delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("version", "Elasticsearch Version", {
      description:
        "The Elasticsearch version it works with, for example 8.15.0 or 8.* for bundles.",
    }),
    f("downloadUrl", "Download URL", { required: false }),
    f("extensionType", "Type", { required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("lastModified", "Last Modified", { required: false, editable: false }),
    f("deploymentIds", "Used By", { required: false, editable: false }),
  ],
  outputs: [o("extensionId", "Extension ID"), o("url", "Plan URL")],
  dependsOn: [{ fieldKey: "deploymentIds", targetTypeId: "deployment", label: "used by" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "puzzle",
});

/** `GET /api/v1/billing/organization/{id}/budgets` (Billing API). */
export const BudgetResourceType = rt({
  name: "Budget",
  id: "budget",
  description:
    "A monthly Elastic Cloud budget in ECUs (1 ECU is $1) for the whole organization or one deployment or project, with alert thresholds Elastic emails about. Create, edit, pause and delete budgets.",
  fields: [
    f("name", "Name", { required: false }),
    f("amount", "Monthly Amount (ECU)", { kind: "number" }),
    f("alertThresholds", "Alert Thresholds (%)", {
      required: false,
      description:
        "Comma-separated percentages of the budget to alert at, for example 50, 80, 100.",
    }),
    f("active", "Active", { kind: "boolean", required: false }),
    f("scope", "Scope", { required: false, editable: false }),
    f("scopeIds", "Scoped To", { required: false, editable: false }),
    f("recipients", "Recipients", { required: false, editable: false }),
    f("lastExceededAt", "Last Exceeded", { required: false, editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("budgetId", "Budget ID")],
  dependsOn: [{ fieldKey: "scopeIds", targetTypeId: "deployment", label: "budgets" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "dollar",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  DeploymentResourceType,
  ProjectResourceType,
  TrafficFilterResourceType,
  ServerlessTrafficFilterResourceType,
  ExtensionResourceType,
  BudgetResourceType,
];
