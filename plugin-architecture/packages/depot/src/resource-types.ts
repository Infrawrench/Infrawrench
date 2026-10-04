import { f, o, rt } from "@infrawrench/plugin-base";
import { HARDWARE_OPTIONS } from "./hardware.js";

export const PROJECT_TYPE = "depot-project";
export const BUILD_TYPE = "depot-build";
export const TOKEN_TYPE = "depot-token";
export const TRUST_POLICY_TYPE = "depot-trust-policy";
export const IMAGE_TYPE = "depot-registry-image";
export const ACTIONS_REPO_TYPE = "depot-actions-repo";

/**
 * A Depot project: the unit container builds, their layer cache and the
 * project's registry belong to. `ProjectService` (`depot.core.v1`) can list,
 * create, update (name, region, cache policy, builder size), delete and reset
 * one; reset terminates the project's builders and deletes its cache.
 */
export const ProjectResourceType = rt({
  name: "Project",
  id: PROJECT_TYPE,
  description:
    "A Depot project: container builds run on its builders, in its region, against its layer cache.",
  fields: [
    f("projectId", "Project ID", { editable: false }),
    f("name", "Name"),
    f("regionId", "Region", {
      kind: "enum",
      enumValues: ["us-east-1", "eu-central-1"],
      description: "Where the project's builders and cache live. Changing it starts a cold cache.",
    }),
    f("hardware", "Builder Size", {
      kind: "enum",
      required: false,
      enumValues: HARDWARE_OPTIONS.map((h) => h.value),
      description: "vCPUs x GB of memory for each builder. default leaves Depot's choice.",
    }),
    f("cacheKeepGb", "Cache Size Limit (GB)", {
      kind: "number",
      required: false,
      description: "Layer cache kept per architecture before the oldest entries are evicted.",
    }),
    f("cacheKeepDays", "Cache Retention (days)", {
      kind: "number",
      required: false,
      description: "Cache entries unused for this many days are evicted. 0 keeps them.",
    }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("builds30d", "Builds (30 days)", { kind: "number", required: false, editable: false }),
    f("buildMinutes30d", "Build Minutes (30 days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("layerCacheGb", "Layer Cache Used (GB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [
    o("projectId", "Project ID", {
      description: "Pass as --project or DEPOT_PROJECT_ID to the depot CLI.",
    }),
    o("projectName", "Project Name"),
    o("registryRepository", "Registry Repository", {
      description:
        "Where depot build --save stores this project's images (registry.depot.dev/<project-id>), tagged by build ID.",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "build",
  secretExportTemplates: [
    {
      id: "depot-project",
      displayName: "Depot project",
      description: "DEPOT_PROJECT_ID for depot build and depot bake",
      entries: [{ envKey: "DEPOT_PROJECT_ID", outputKey: "projectId" }],
    },
  ],
});

/** A container build in a project. Read-only: builds are created by the CLI. */
export const BuildResourceType = rt({
  name: "Build",
  pinnable: false,
  id: BUILD_TYPE,
  description:
    "A recent container build, with its duration, outcome and how much of it Depot's cache served.",
  fields: [
    f("buildId", "Build ID"),
    f("projectId", "Project", { required: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["running", "success", "failed", "error", "canceled", "unknown"],
    }),
    f("createdAt", "Created", { required: false }),
    f("startedAt", "Started", { required: false }),
    f("finishedAt", "Finished", { required: false }),
    f("durationSeconds", "Duration (s)", { kind: "number", required: false }),
    f("savedSeconds", "Time Saved by Cache (s)", { kind: "number", required: false }),
    f("cachedSteps", "Cached Steps", { kind: "number", required: false }),
    f("totalSteps", "Total Steps", { kind: "number", required: false }),
    f("cacheHitRate", "Cache Hit Rate (%)", { kind: "number", required: false }),
  ],
  outputs: [o("buildId", "Build ID")],
  parentTypeId: PROJECT_TYPE,
  dependsOn: [{ fieldKey: "projectId", targetTypeId: PROJECT_TYPE, label: "built in" }],
  iconKey: "deployment",
});

/**
 * A project token: lets CI build in one project without an organization
 * token. The API lists only id and description; the secret is shown once,
 * at creation.
 */
export const TokenResourceType = rt({
  name: "Project Token",
  pinnable: false,
  id: TOKEN_TYPE,
  description:
    "A token scoped to one project, for CI systems that cannot use an OIDC trust relationship. Its secret is only shown when it is created.",
  fields: [
    f("tokenId", "Token ID", { editable: false }),
    f("description", "Description"),
    f("projectId", "Project", { required: false, editable: false }),
  ],
  outputs: [
    o("tokenId", "Token ID"),
    o("token", "Token", {
      sensitive: true,
      description: "Only available right after creation; Depot never returns it again.",
    }),
  ],
  parentTypeId: PROJECT_TYPE,
  dependsOn: [{ fieldKey: "projectId", targetTypeId: PROJECT_TYPE, label: "grants access to" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
  secretExportTemplates: [
    {
      id: "depot-token",
      displayName: "Depot token",
      description: "DEPOT_TOKEN for CI",
      entries: [{ envKey: "DEPOT_TOKEN", outputKey: "token" }],
    },
  ],
});

/**
 * An OIDC trust relationship: CI from one GitHub repository, CircleCI
 * project, Buildkite pipeline or GitLab project may build in this project
 * without a stored token. The API can add and remove them, not edit them.
 */
export const TrustPolicyResourceType = rt({
  name: "Trust Relationship",
  pinnable: false,
  id: TRUST_POLICY_TYPE,
  description:
    "An OIDC trust relationship that lets one CI repository or pipeline build in the project without a stored token.",
  fields: [
    f("trustPolicyId", "Trust Policy ID"),
    f("provider", "CI Provider", {
      kind: "enum",
      enumValues: ["github", "circleci", "buildkite", "gitlab"],
    }),
    f("subject", "Trusted Source"),
    f("projectId", "Project", { required: false }),
  ],
  outputs: [o("trustPolicyId", "Trust Policy ID")],
  parentTypeId: PROJECT_TYPE,
  dependsOn: [{ fieldKey: "projectId", targetTypeId: PROJECT_TYPE, label: "trusted by" }],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "shield",
});

/** An image tag in a project's Depot registry. */
export const RegistryImageResourceType = rt({
  name: "Registry Image",
  pinnable: false,
  id: IMAGE_TYPE,
  description: "An image tag stored in the project's Depot registry, counted against storage.",
  fields: [
    f("tag", "Tag"),
    f("digest", "Digest", { required: false }),
    f("pushedAt", "Pushed", { required: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false }),
    f("projectId", "Project", { required: false }),
  ],
  outputs: [o("imageRef", "Image Reference"), o("digest", "Digest")],
  parentTypeId: PROJECT_TYPE,
  dependsOn: [{ fieldKey: "projectId", targetTypeId: PROJECT_TYPE, label: "stored in" }],
  supportsDelete: true,
  iconKey: "image",
});

/**
 * A GitHub repository running jobs on Depot's runners in the current billing
 * cycle, from `UsageService/GetUsage`. Not a Depot object in its own right:
 * it is how the API attributes runner minutes, so it is how they are listed.
 */
export const ActionsRepoResourceType = rt({
  name: "GitHub Actions Repository",
  plural: "GitHub Actions Repositories",
  id: ACTIONS_REPO_TYPE,
  description:
    "A repository whose GitHub Actions jobs ran on Depot runners this billing cycle, with minutes by workflow and runner.",
  fields: [
    f("repo", "Repository"),
    f("jobs", "Jobs (cycle)", { kind: "number", required: false }),
    f("minutesElapsed", "Elapsed Minutes (cycle)", { kind: "number", required: false }),
    f("minutesBilled", "Billed Minutes (cycle)", { kind: "number", required: false }),
    f("cycleStart", "Cycle Start", { required: false }),
  ],
  outputs: [o("repo", "Repository")],
  supportsMetrics: true,
  iconKey: "github",
});
