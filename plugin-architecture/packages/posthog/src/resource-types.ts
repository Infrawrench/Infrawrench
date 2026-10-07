import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * PostHog resource types. Project-scoped objects use `<projectId>/<id>` as
 * their external id, because every route needs the project back.
 */

const PROJECT = f("projectId", "Project", { required: false, editable: false });
const REGION = f("region", "Region", { required: false, editable: false });
const PROJECT_DEP = { fieldKey: "projectId", targetTypeId: "project", label: "in" };
const CREATED = f("createdAt", "Created", { required: false, editable: false });
const TAGS = f("tags", "Tags", { required: false, description: "Comma-separated." });

/** Project-scoped route segment per type. */
export const PROJECT_ROUTES: Record<string, string> = {
  "feature-flag": "feature_flags",
  experiment: "experiments",
  cohort: "cohorts",
  dashboard: "dashboards",
  insight: "insights",
  action: "actions",
  annotation: "annotations",
  "hog-function": "hog_functions",
  "batch-export": "batch_exports",
};

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "The PostHog organization: plan, member and project counts, and this billing period's spend and projection. The Metrics tab charts daily spend by product.",
  fields: [
    f("name", "Name", { editable: false }),
    f("slug", "Slug", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("memberCount", "Members", { kind: "number", required: false, editable: false }),
    f("projectCount", "Projects", { kind: "number", required: false, editable: false }),
    f("currentTotalUsd", "Spend This Period (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("projectedTotalUsd", "Projected (USD)", { kind: "number", required: false, editable: false }),
    f("periodEnd", "Period Ends", { required: false, editable: false }),
    REGION,
    CREATED,
  ],
  outputs: [o("organizationId", "Organization ID")],
  accountRoot: true,
  supportsMetrics: true,
  iconKey: "account",
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "A PostHog project. Its project API key is an output for SDKs; the Metrics tab charts events per hour, and the Query tab runs HogQL.",
  fields: [
    f("name", "Name", { editable: false }),
    f("timezone", "Time Zone", { required: false, editable: false }),
    f("ingestedEvent", "Has Events", { kind: "boolean", required: false, editable: false }),
    f("isDemo", "Demo", { kind: "boolean", required: false, editable: false }),
    f("projectId", "Project ID", { editable: false }),
    REGION,
  ],
  outputs: [
    o("projectApiKey", "Project API Key", {
      description: "The public phc_ key SDKs send events with.",
    }),
    o("apiHost", "API Host"),
    o("projectId", "Project ID"),
  ],
  supportsMetrics: true,
  supportsRestQuery: true,
  secretExportTemplates: [
    {
      id: "posthog-sdk",
      displayName: "PostHog SDK",
      description: "Project key and host for posthog-js and the server SDKs.",
      entries: [
        { envKey: "POSTHOG_API_KEY", outputKey: "projectApiKey" },
        { envKey: "POSTHOG_HOST", outputKey: "apiHost" },
      ],
    },
  ],
  iconKey: "folder",
});

export const FeatureFlagResourceType = rt({
  name: "Feature Flag",
  id: "feature-flag",
  description:
    "A feature flag. Create flags, change the description, rollout percentage and tags, turn them on and off, roll out to everyone, or delete them. The Metrics tab charts how often the flag is evaluated.",
  fields: [
    f("name", "Description", { required: false }),
    f("active", "Enabled", { kind: "boolean", required: false }),
    f("rolloutPercentage", "Rollout (%)", {
      kind: "number",
      required: false,
      description: "Share of users the first release condition rolls out to (0 to 100).",
    }),
    TAGS,
    f("key", "Key", { editable: false }),
    f("variants", "Variants", { required: false, editable: false }),
    f("conditionCount", "Release Conditions", { kind: "number", required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("lastCalledAt", "Last Evaluated", { required: false, editable: false }),
    f("filtersJson", "Filters (JSON)", { required: false, editable: false }),
    PROJECT,
    REGION,
    CREATED,
  ],
  outputs: [o("key", "Flag Key")],
  dependsOn: [PROJECT_DEP],
  parentTypeId: "project",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "flag",
});

export const ExperimentResourceType = rt({
  name: "Experiment",
  id: "experiment",
  description:
    "An A/B experiment on a feature flag. Launch, pause, resume or end it, archive it, edit its name and description, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("featureFlagKey", "Feature Flag", { required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("startDate", "Started", { required: false, editable: false }),
    f("endDate", "Ended", { required: false, editable: false }),
    f("conclusion", "Conclusion", { required: false, editable: false }),
    f("archived", "Archived", { kind: "boolean", required: false, editable: false }),
    PROJECT,
    REGION,
    CREATED,
  ],
  outputs: [],
  parentTypeId: "project",
  dependsOn: [
    PROJECT_DEP,
    {
      fieldKey: "featureFlagKey",
      targetTypeId: "feature-flag",
      targetKey: "key",
      label: "runs on",
    },
  ],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "flask",
});

export const CohortResourceType = rt({
  name: "Cohort",
  id: "cohort",
  description:
    "A group of persons, static or computed from filters. Rename it, change the description, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("count", "Persons", { kind: "number", required: false, editable: false }),
    f("isStatic", "Static", { kind: "boolean", required: false, editable: false }),
    f("isCalculating", "Calculating", { kind: "boolean", required: false, editable: false }),
    f("lastCalculation", "Last Calculated", { required: false, editable: false }),
    f("filtersJson", "Filters (JSON)", { required: false, editable: false }),
    PROJECT,
    REGION,
    CREATED,
  ],
  outputs: [],
  dependsOn: [PROJECT_DEP],
  parentTypeId: "project",
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const DashboardResourceType = rt({
  name: "Dashboard",
  id: "dashboard",
  description: "A dashboard of insights. Create, rename, describe, pin, tag or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("pinned", "Pinned", { kind: "boolean", required: false }),
    TAGS,
    f("lastAccessedAt", "Last Viewed", { required: false, editable: false }),
    PROJECT,
    REGION,
    CREATED,
  ],
  outputs: [o("url", "Dashboard URL")],
  dependsOn: [PROJECT_DEP],
  parentTypeId: "project",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "dashboard",
});

export const InsightResourceType = rt({
  name: "Insight",
  id: "insight",
  description:
    "A saved insight (trend, funnel, retention, SQL…). Rename it, change the description, or delete it.",
  fields: [
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false }),
    f("kind", "Kind", { required: false, editable: false }),
    f("shortId", "Short ID", { required: false, editable: false }),
    f("dashboards", "Dashboards", { required: false, editable: false }),
    f("dashboardRefs", "Dashboard IDs", { required: false, editable: false }),
    f("lastRefresh", "Last Refreshed", { required: false, editable: false }),
    PROJECT,
    REGION,
    CREATED,
  ],
  outputs: [o("url", "Insight URL")],
  parentTypeId: "project",
  dependsOn: [
    PROJECT_DEP,
    {
      fieldKey: "dashboardRefs",
      targetTypeId: "dashboard",
      matchTemplate: "{dashboardRefs}",
      label: "on",
    },
  ],
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "chart",
});

export const ActionResourceType = rt({
  name: "Action",
  id: "action",
  description:
    "A named action combining events and conditions. Rename it, change the description, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("stepCount", "Steps", { kind: "number", required: false, editable: false }),
    f("postToSlack", "Posts to Slack", { kind: "boolean", required: false, editable: false }),
    f("stepsJson", "Steps (JSON)", { required: false, editable: false }),
    PROJECT,
    REGION,
    CREATED,
  ],
  outputs: [],
  dependsOn: [PROJECT_DEP],
  parentTypeId: "project",
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "bolt",
});

export const AnnotationResourceType = rt({
  name: "Annotation",
  id: "annotation",
  description:
    "A note pinned to a point in time on charts, such as a deploy. Create, edit or delete annotations.",
  fields: [
    f("content", "Content"),
    f("dateMarker", "Date", { required: false, editable: false }),
    f("scope", "Scope", { required: false, editable: false }),
    f("creationType", "Created By", { required: false, editable: false }),
    PROJECT,
    REGION,
  ],
  outputs: [],
  dependsOn: [PROJECT_DEP],
  parentTypeId: "project",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "note",
});

export const HogFunctionResourceType = rt({
  name: "Destination",
  id: "hog-function",
  description:
    "A Hog function: a realtime destination, transformation, webhook source or site app. Turn it on and off or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("template", "Template", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("description", "Description", { required: false, editable: false }),
    PROJECT,
    REGION,
    CREATED,
  ],
  outputs: [],
  dependsOn: [PROJECT_DEP],
  parentTypeId: "project",
  supportsDelete: true,
  iconKey: "webhook",
});

export const BatchExportResourceType = rt({
  name: "Batch Export",
  id: "batch-export",
  description:
    "A scheduled export of events or persons to a warehouse or bucket (S3, BigQuery, Snowflake, Postgres, Redshift, Databricks…). Pause, resume or delete it, and see its latest runs.",
  fields: [
    f("name", "Name", { editable: false }),
    f("destination", "Destination", { required: false, editable: false }),
    f("model", "Model", { required: false, editable: false }),
    f("interval", "Interval", { required: false, editable: false }),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    f("lastRunStatus", "Last Run", { required: false, editable: false }),
    f("lastRunAt", "Last Run At", { required: false, editable: false }),
    PROJECT,
    REGION,
    CREATED,
  ],
  outputs: [],
  dependsOn: [PROJECT_DEP],
  parentTypeId: "project",
  supportsDelete: true,
  iconKey: "export",
});

export const MemberResourceType = rt({
  name: "Member",
  id: "member",
  description:
    "A member of the organization. Change their level (member, admin, owner) or remove them.",
  fields: [
    f("level", "Level", { kind: "enum", enumValues: ["member", "admin", "owner"] }),
    f("email", "Email", { required: false, editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("twoFactor", "2FA", { kind: "boolean", required: false, editable: false }),
    f("lastLogin", "Last Login", { required: false, editable: false }),
    f("joinedAt", "Joined", { required: false, editable: false }),
  ],
  outputs: [],
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "user",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  ProjectResourceType,
  FeatureFlagResourceType,
  ExperimentResourceType,
  CohortResourceType,
  DashboardResourceType,
  InsightResourceType,
  ActionResourceType,
  AnnotationResourceType,
  HogFunctionResourceType,
  BatchExportResourceType,
  MemberResourceType,
];
