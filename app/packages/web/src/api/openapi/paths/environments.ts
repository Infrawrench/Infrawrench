import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import { FreezeLockedResponse } from "./change-freezes";
import type { BuildContext } from "../context";

const TemplateFieldValue = z
  .union([
    strict({ kind: z.literal("literal"), value: z.string() }),
    strict({ kind: z.literal("parameter"), parameter: z.string() }),
    strict({ kind: z.literal("output"), member: z.string(), outputKey: z.string() }),
    strict({ kind: z.literal("member-id"), member: z.string() }),
  ])
  .openapi("EnvironmentTemplateFieldValue", {
    description:
      "What a captured create-form field is filled with at instantiation. `literal` is the " +
      "captured value; `parameter` is a field the user chose to vary; `output` is another " +
      "member's resolved output (a connection string, an IP — the captured half of an output " +
      "reference); `member-id` is another member's provider-side id.",
  });

const EnvironmentParameter = strict({
  key: z.string(),
  label: z.string(),
  type: z.enum(["string", "number", "select"]),
  required: z.boolean(),
  defaultValue: z.string().optional(),
  options: z.array(strict({ id: z.string(), label: z.string() })).optional(),
  description: z.string().optional(),
}).openapi("EnvironmentParameter");

const InstanceStatus = z
  .enum(["creating", "active", "partial", "tearing-down", "deleted", "failed"])
  .openapi({
    description:
      "`partial` means a create failed part-way: the members that were created are recorded " +
      "and can still be torn down, which is what stops a half-finished run leaving cloud " +
      "resources with no row pointing at them.",
  });

const MemberStatus = z.enum(["pending", "created", "failed", "deleted"]);

export function registerEnvironmentPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const EnvironmentTemplateMember = strict({
    key: z.string().describe("Unique within the template; the id references are written against."),
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    accountId: Uuid,
    sourceName: z.string(),
    sourceResourceId: z.string().optional(),
    nameFieldKey: z
      .string()
      .optional()
      .describe(
        "The create-form field carrying the resource's name, detected at capture by matching " +
          "the captured value against the source's display name. The instance name prefix is " +
          "applied to this field and no other.",
      ),
    parentMember: z.string().optional(),
    fields: z.record(z.string(), TemplateFieldValue),
  }).openapi("EnvironmentTemplateMember");

  const EnvironmentTemplate = strict({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    parameters: z.array(EnvironmentParameter),
    members: z.array(EnvironmentTemplateMember),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    activeInstanceCount: z.number().int().optional(),
  }).openapi("EnvironmentTemplate");

  const EnvironmentTemplateList = strict({
    templates: z.array(EnvironmentTemplate),
  }).openapi("EnvironmentTemplateList");

  const EnvironmentTemplateInput = strict({
    name: z.string().max(60),
    description: z.string().nullable().optional(),
    parameters: z.array(EnvironmentParameter),
    members: z.array(EnvironmentTemplateMember),
  }).openapi("EnvironmentTemplateInput");

  const CaptureRequest = strict({
    resourceIds: z.array(z.string()).optional(),
    accountId: Uuid.optional(),
    tagKey: z.string().optional(),
    tagValue: z.string().optional(),
  }).openapi("EnvironmentCaptureRequest");

  const CaptureDraftMember = EnvironmentTemplateMember.extend({
    fieldMeta: z.record(
      z.string(),
      strict({
        label: z.string(),
        kind: z.string(),
        required: z.boolean(),
        options: z.array(strict({ id: z.string(), label: z.string() })).optional(),
        parameterisable: z.boolean(),
      }),
    ),
  }).openapi("EnvironmentCaptureDraftMember");

  const CaptureDraft = strict({
    members: z.array(CaptureDraftMember),
    suggestedParameters: z.array(EnvironmentParameter),
    skipped: z.array(
      strict({ resourceId: z.string(), displayName: z.string(), reason: z.string() }),
    ),
  }).openapi("EnvironmentCaptureDraft");

  const EnvironmentInstanceMember = strict({
    id: Uuid,
    memberKey: z.string(),
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    accountId: Uuid,
    resourceId: z.string().nullable(),
    externalId: z.string().nullable(),
    displayName: z.string(),
    status: MemberStatus,
    error: z.string().nullable(),
    leaseId: Uuid.nullable().describe("The lease that auto-deletes this member at the TTL."),
    position: z.number().int(),
  }).openapi("EnvironmentInstanceMember");

  const EnvironmentInstance = strict({
    id: Uuid,
    templateId: Uuid.nullable(),
    templateName: z.string(),
    name: z.string(),
    namePrefix: z.string(),
    parameters: z.record(z.string(), z.string()),
    status: InstanceStatus,
    expiresAt: IsoDateTime,
    error: z.string().nullable(),
    members: z.array(EnvironmentInstanceMember),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    completedAt: IsoDateTime.nullable(),
  }).openapi("EnvironmentInstance");

  const EnvironmentInstanceList = strict({
    instances: z.array(EnvironmentInstance),
  }).openapi("EnvironmentInstanceList");

  const InstantiateRequest = strict({
    name: z.string().max(60),
    parameters: z.record(z.string(), z.string()).optional(),
    ttlHours: z
      .number()
      .describe("Required. Capped by the org's `maxTtlHours` setting and by a 720-hour ceiling."),
    accountOverrides: z.record(z.string(), Uuid).optional(),
    note: z.string().max(500).optional(),
  }).openapi("EnvironmentInstantiateRequest");

  const EstimateRequest = strict({
    parameters: z.record(z.string(), z.string()).optional(),
    accountOverrides: z.record(z.string(), Uuid).optional(),
  }).openapi("EnvironmentEstimateRequest");

  const EnvironmentCostEstimate = strict({
    monthlyAmount: z
      .number()
      .nullable()
      .describe("Null means 'could not be priced', which is not the same as zero."),
    currency: z.string().nullable(),
    partial: z
      .boolean()
      .describe("True when at least one member is unpriced — read as 'at least'."),
    unpricedCount: z.number().int(),
    members: z.array(
      strict({
        memberKey: z.string(),
        displayName: z.string(),
        monthlyAmount: z.number().nullable(),
        currency: z.string().nullable(),
      }),
    ),
  }).openapi("EnvironmentCostEstimate");

  const EnvironmentSettings = strict({
    maxTtlHours: z.number().int(),
    defaultTtlHours: z.number().int(),
  }).openapi("EnvironmentSettings");

  const tags = ["Ephemeral environments"];

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/environments/settings",
    tags,
    summary: "Get the organization's environment TTL rails",
    description:
      "The longest TTL an instantiation may ask for and the TTL the form pre-fills. Absent " +
      "settings normalize into the shipped defaults (168h / 24h).",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The TTL rails",
        content: { "application/json": { schema: EnvironmentSettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/environments/settings",
    tags,
    summary: "Set the organization's environment TTL rails",
    description:
      "`org:settings:write`, not `resources:write` — this is a governance decision about how " +
      "long the organization is willing to pay for a throwaway environment. Clamped to a " +
      "720-hour ceiling; the default is clamped to the maximum. Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: EnvironmentSettings.partial() } } },
    },
    responses: {
      200: {
        description: "The stored rails",
        content: { "application/json": { schema: EnvironmentSettings } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/environments/capture",
    tags,
    summary: "Preview a template capture",
    description:
      "Turn a selection of live resources into a draft template. **Persists nothing** — the " +
      "editor shows the draft so the user can choose which fields to vary before saving. The " +
      "shape of every member comes from the plugin's own `getCreateConfig`: a captured value " +
      "with no matching create field is dropped, and a resource type the plugin cannot create " +
      "is reported in `skipped` with a reason rather than silently omitted. Recorded output " +
      "references whose target is also in the selection are preserved as `output` field " +
      "values; a value that is exactly another selected resource's external id becomes a " +
      "`member-id`.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CaptureRequest } } },
    },
    responses: {
      200: {
        description: "The draft template",
        content: { "application/json": { schema: CaptureDraft } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/environments/templates",
    tags,
    summary: "List environment templates",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's templates",
        content: { "application/json": { schema: EnvironmentTemplateList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/environments/templates",
    tags,
    summary: "Create an environment template",
    description:
      "Save a capture draft as a template. Member keys must be unique, every parameter and " +
      "member reference must resolve, and the members must be orderable — a dependency cycle " +
      "is rejected here rather than half-way through an apply. Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: EnvironmentTemplateInput } } },
    },
    responses: {
      201: {
        description: "The created template",
        content: { "application/json": { schema: EnvironmentTemplate } },
      },
      400: ErrorResponses[400],
      409: {
        description: "A template with that name already exists",
        content: {
          "application/json": {
            schema: strict({ error: z.string() }).openapi("EnvironmentTemplateConflict"),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/environments/templates/{templateId}",
    tags,
    summary: "Get an environment template",
    request: { params: OrgIdParam.extend({ templateId: Uuid }) },
    responses: {
      200: {
        description: "The template",
        content: { "application/json": { schema: EnvironmentTemplate } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/environments/templates/{templateId}",
    tags,
    summary: "Replace an environment template",
    description: "The whole document is replaced. Live instances are unaffected. Audit-logged.",
    request: {
      params: OrgIdParam.extend({ templateId: Uuid }),
      body: { content: { "application/json": { schema: EnvironmentTemplateInput } } },
    },
    responses: {
      200: {
        description: "The updated template",
        content: { "application/json": { schema: EnvironmentTemplate } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/environments/templates/{templateId}",
    tags,
    summary: "Delete an environment template",
    description:
      "Live instances keep running and keep their TTL — they own real resources, and the " +
      "template is only where they came from. Their `templateId` becomes null; the " +
      "denormalized `templateName` is what the surface reads. Audit-logged.",
    request: { params: OrgIdParam.extend({ templateId: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/environments/templates/{templateId}/estimate",
    tags,
    summary: "Price an instantiation before it runs",
    description:
      "Runs each member's create fields through the plugin's own `estimateCost`. A member the " +
      "plugin cannot price is counted in `unpricedCount` and makes the total `partial` — " +
      "`null` is never rounded to zero.",
    request: {
      params: OrgIdParam.extend({ templateId: Uuid }),
      body: { content: { "application/json": { schema: EstimateRequest } } },
    },
    responses: {
      200: {
        description: "The forward-looking estimate",
        content: { "application/json": { schema: EnvironmentCostEstimate } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/environments/templates/{templateId}/instantiate",
    tags,
    summary: "Stamp out an environment",
    description:
      "Creates the template's resources in dependency order through the ordinary " +
      "`createResource` path, name-prefixed per instance, and attaches an auto-delete lease " +
      "to each so expiry runs through the existing lease pass. `ttlHours` is **required**. " +
      "Requires `resources:write` **and** `resources:delete` (the lease is a standing " +
      "deletion, the same rule `POST /leases` applies), and is blocked by an active change " +
      "freeze. A create that fails part-way returns a `partial` instance whose created " +
      "members are recorded and tearable-down, never an error with orphaned resources behind " +
      "it. Audit-logged.",
    request: {
      params: OrgIdParam.extend({ templateId: Uuid }),
      body: { content: { "application/json": { schema: InstantiateRequest } } },
    },
    responses: {
      201: {
        description: "The instance — check `status` for `partial`",
        content: { "application/json": { schema: EnvironmentInstance } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "The organization is at its live-environment limit",
        content: {
          "application/json": {
            schema: strict({ error: z.string() }).openapi("EnvironmentInstanceConflict"),
          },
        },
      },
      423: FreezeLockedResponse,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/environments/instances",
    tags,
    summary: "List environment instances",
    description:
      "Newest first. Reading this also reconciles instances past their deadline against what " +
      "the lease pass already deleted, so an environment whose resources are all gone stops " +
      "reporting itself as running.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's instances",
        content: { "application/json": { schema: EnvironmentInstanceList } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/environments/instances/{instanceId}",
    tags,
    summary: "Get an environment instance",
    request: { params: OrgIdParam.extend({ instanceId: Uuid }) },
    responses: {
      200: {
        description: "The instance",
        content: { "application/json": { schema: EnvironmentInstance } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/environments/instances/{instanceId}/teardown",
    tags,
    summary: "Tear an environment down now",
    description:
      "Deletes every created member through the ordinary `deleteResource` path, in reverse " +
      "creation order. Idempotent: a member already gone, a resource the provider answers " +
      "404 for, and an instance already torn down all succeed quietly, so this is safe to " +
      "retry. Blocked by an active change freeze. Audit-logged.",
    request: { params: OrgIdParam.extend({ instanceId: Uuid }) },
    responses: {
      200: {
        description: "The instance — `partial` when some member could not be deleted",
        content: { "application/json": { schema: EnvironmentInstance } },
      },
      404: ErrorResponses[404],
      423: FreezeLockedResponse,
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/environments/instances/{instanceId}",
    tags,
    summary: "Forget a torn-down environment",
    description:
      "Removes the record. Refuses while the instance still owns resources — the row is the " +
      "only thing that knows they exist. Audit-logged.",
    request: { params: OrgIdParam.extend({ instanceId: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: ErrorResponses[404],
      409: {
        description: "The environment is still live — tear it down first",
        content: {
          "application/json": {
            schema: strict({ error: z.string() }).openapi("EnvironmentStillLive"),
          },
        },
      },
    },
  });
}
