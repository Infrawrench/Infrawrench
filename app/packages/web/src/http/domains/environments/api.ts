/**
 * Ephemeral environments: `/api/org/:orgId/environments`, the endpoint
 * definitions. Capture a set of resources as a parameterised template, stamp
 * copies of it out with a mandatory TTL, and tear them down.
 *
 * Permissions follow the **leases stance**, deliberately, rather than adding a
 * new permission family: reads are `resources:read` (a template is a view over
 * the org's own resources), template edits are `resources:write`, and
 * teardown is `resources:delete`. Instantiation requires `resources:write`
 * **and** `resources:delete` (the second checked in the handler): every
 * instance carries an auto-delete lease, which is the same standing-deletion
 * argument `POST /leases` makes for `autoDelete: true`. The org's TTL ceiling
 * is `org:settings:write`, because it is a governance decision about spend
 * rather than an edit to a resource.
 *
 * Instantiation and teardown both pass through the change-freeze gate: one
 * commits the organization to spend, the other deletes.
 *
 * The write bodies are documented here and read by hand in the handlers, as
 * the routes always did (a wrongly typed optional field is ignored, numbers in
 * a parameter map are stringified), so those endpoints are served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Forbidden, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { ChangeFreezeBlocked } from "../../schemas/change-freeze";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";
import { PluginId } from "../../schemas/plugin-registry";

/** The 409s, each its own component as the hand-written spec named them. */
export class EnvironmentTemplateConflict extends Schema.Error<EnvironmentTemplateConflict>(
  "infrawrench/http/EnvironmentTemplateConflict",
)(
  { error: Schema.String },
  {
    httpApiStatus: 409,
    identifier: "EnvironmentTemplateConflict",
    description: "A template with that name already exists",
  },
) {}

export class EnvironmentInstanceConflict extends Schema.Error<EnvironmentInstanceConflict>(
  "infrawrench/http/EnvironmentInstanceConflict",
)(
  { error: Schema.String },
  {
    httpApiStatus: 409,
    identifier: "EnvironmentInstanceConflict",
    description: "The organization is at its live-environment limit",
  },
) {}

export class EnvironmentStillLive extends Schema.Error<EnvironmentStillLive>(
  "infrawrench/http/EnvironmentStillLive",
)(
  { error: Schema.String },
  {
    httpApiStatus: 409,
    identifier: "EnvironmentStillLive",
    description: "The environment is still live; tear it down first",
  },
) {}

const TemplateFieldValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("literal"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("parameter"), parameter: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("output"),
    member: Schema.String,
    outputKey: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("member-id"), member: Schema.String }),
]).annotate({
  identifier: "EnvironmentTemplateFieldValue",
  description:
    "What a captured create-form field is filled with at instantiation. `literal` is the " +
    "captured value; `parameter` is a field the user chose to vary; `output` is another " +
    "member's resolved output (a connection string, an IP; the captured half of an output " +
    "reference); `member-id` is another member's provider-side id.",
});

const SelectOption = Schema.Struct({ id: Schema.String, label: Schema.String });

const EnvironmentParameter = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: Schema.Literals(["string", "number", "select"]),
  required: Schema.Boolean,
  defaultValue: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(SelectOption)),
  description: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "EnvironmentParameter" });

const InstanceStatus = Schema.Literals([
  "creating",
  "active",
  "partial",
  "tearing-down",
  "deleted",
  "failed",
]).annotate({
  description:
    "`partial` means a create failed part-way: the members that were created are recorded " +
    "and can still be torn down, which is what stops a half-finished run leaving cloud " +
    "resources with no row pointing at them.",
});

const memberFields = {
  key: Schema.String.annotate({
    description: "Unique within the template; the id references are written against.",
  }),
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  sourceName: Schema.String,
  sourceResourceId: Schema.optionalKey(Schema.String),
  nameFieldKey: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The create-form field carrying the resource's name, detected at capture by matching " +
        "the captured value against the source's display name. The instance name prefix is " +
        "applied to this field and no other.",
    }),
  ),
  parentMember: Schema.optionalKey(Schema.String),
  fields: Schema.Record(Schema.String, TemplateFieldValue),
};

const EnvironmentTemplateMember = Schema.Struct(memberFields).annotate({
  identifier: "EnvironmentTemplateMember",
});

export const EnvironmentTemplate = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  parameters: Schema.Array(EnvironmentParameter),
  members: Schema.Array(EnvironmentTemplateMember),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  activeInstanceCount: Schema.optionalKey(Schema.Int),
}).annotate({ identifier: "EnvironmentTemplate" });

export const EnvironmentTemplateList = Schema.Struct({
  templates: Schema.Array(EnvironmentTemplate),
}).annotate({ identifier: "EnvironmentTemplateList" });

const EnvironmentTemplateInput = Schema.Struct({
  name: Schema.String.check(maxLength(60)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parameters: Schema.Array(EnvironmentParameter),
  members: Schema.Array(EnvironmentTemplateMember),
}).annotate({ identifier: "EnvironmentTemplateInput" });

const CaptureRequest = Schema.Struct({
  resourceIds: Schema.optionalKey(Schema.Array(Schema.String)),
  accountId: Schema.optionalKey(Uuid),
  tagKey: Schema.optionalKey(Schema.String),
  tagValue: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "EnvironmentCaptureRequest" });

const CaptureDraftMember = Schema.Struct({
  ...memberFields,
  fieldMeta: Schema.Record(
    Schema.String,
    Schema.Struct({
      label: Schema.String,
      kind: Schema.String,
      required: Schema.Boolean,
      options: Schema.optionalKey(Schema.Array(SelectOption)),
      parameterisable: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "EnvironmentCaptureDraftMember" });

export const CaptureDraft = Schema.Struct({
  members: Schema.Array(CaptureDraftMember),
  suggestedParameters: Schema.Array(EnvironmentParameter),
  skipped: Schema.Array(
    Schema.Struct({ resourceId: Schema.String, displayName: Schema.String, reason: Schema.String }),
  ),
}).annotate({ identifier: "EnvironmentCaptureDraft" });

const EnvironmentInstanceMember = Schema.Struct({
  id: Uuid,
  memberKey: Schema.String,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  resourceId: Schema.NullOr(Schema.String),
  externalId: Schema.NullOr(Schema.String),
  displayName: Schema.String,
  status: Schema.Literals(["pending", "created", "failed", "deleted"]),
  error: Schema.NullOr(Schema.String),
  leaseId: Schema.NullOr(Uuid).annotate({
    description: "The lease that auto-deletes this member at the TTL.",
  }),
  position: Schema.Int,
}).annotate({ identifier: "EnvironmentInstanceMember" });

export const EnvironmentInstance = Schema.Struct({
  id: Uuid,
  templateId: Schema.NullOr(Uuid),
  templateName: Schema.String,
  name: Schema.String,
  namePrefix: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.String),
  status: InstanceStatus,
  expiresAt: IsoDateTime,
  error: Schema.NullOr(Schema.String),
  members: Schema.Array(EnvironmentInstanceMember),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "EnvironmentInstance" });

export const EnvironmentInstanceList = Schema.Struct({
  instances: Schema.Array(EnvironmentInstance),
}).annotate({ identifier: "EnvironmentInstanceList" });

const InstantiateRequest = Schema.Struct({
  name: Schema.String.check(maxLength(60)),
  parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  ttlHours: Schema.Finite.annotate({
    description: "Required. Capped by the org's `maxTtlHours` setting and by a 720-hour ceiling.",
  }),
  accountOverrides: Schema.optionalKey(Schema.Record(Schema.String, Uuid)),
  note: Schema.optionalKey(Schema.String.check(maxLength(500))),
}).annotate({ identifier: "EnvironmentInstantiateRequest" });

const EstimateRequest = Schema.Struct({
  parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  accountOverrides: Schema.optionalKey(Schema.Record(Schema.String, Uuid)),
}).annotate({ identifier: "EnvironmentEstimateRequest" });

export const EnvironmentCostEstimate = Schema.Struct({
  monthlyAmount: Schema.NullOr(Schema.Finite).annotate({
    description: "Null means 'could not be priced', which is not the same as zero.",
  }),
  currency: Schema.NullOr(Schema.String),
  partial: Schema.Boolean.annotate({
    description: "True when at least one member is unpriced, read as 'at least'.",
  }),
  unpricedCount: Schema.Int,
  monthlyKgCo2e: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Estimated monthly kg CO2e of the members that could be placed against a published grid " +
      "figure. Null when none could. See the Carbon tag for the method.",
  }),
  uncarbonedCount: Schema.Int.annotate({
    description: "Sized compute members whose carbon could not be estimated.",
  }),
  members: Schema.Array(
    Schema.Struct({
      memberKey: Schema.String,
      displayName: Schema.String,
      monthlyAmount: Schema.NullOr(Schema.Finite),
      currency: Schema.NullOr(Schema.String),
      monthlyKgCo2e: Schema.NullOr(Schema.Finite),
    }),
  ),
}).annotate({ identifier: "EnvironmentCostEstimate" });

export const EnvironmentSettings = Schema.Struct({
  maxTtlHours: Schema.Int,
  defaultTtlHours: Schema.Int,
}).annotate({ identifier: "EnvironmentSettings" });

const EnvironmentSettingsPatch = Schema.Struct({
  maxTtlHours: Schema.optionalKey(Schema.Int),
  defaultTtlHours: Schema.optionalKey(Schema.Int),
});

const TemplateParams = { orgId: OrgId, templateId: Uuid } as const;
const InstanceParams = { orgId: OrgId, instanceId: Uuid } as const;

export class EnvironmentsGroup extends HttpApiGroup.make("environments")
  .add(
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: EnvironmentSettings,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get the organization's environment TTL rails")
      .annotate(
        OpenApi.Description,
        "The longest TTL an instantiation may ask for and the TTL the form pre-fills. Absent " +
          "settings normalize into the shipped defaults (168h / 24h).",
      )
      .annotate(SuccessDescription, "The TTL rails"),
    HttpApiEndpoint.put("setSettings", "/settings", {
      params: OrgParams,
      payload: EnvironmentSettingsPatch,
      success: EnvironmentSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Set the organization's environment TTL rails")
      .annotate(
        OpenApi.Description,
        "`org:settings:write`, not `resources:write`: this is a governance decision about how " +
          "long the organization is willing to pay for a throwaway environment. Clamped to a " +
          "720-hour ceiling; the default is clamped to the maximum. Audit-logged.",
      )
      .annotate(SuccessDescription, "The stored rails")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("capture", "/capture", {
      params: OrgParams,
      payload: CaptureRequest,
      success: CaptureDraft,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Preview a template capture")
      .annotate(
        OpenApi.Description,
        "Turn a selection of live resources into a draft template. **Persists nothing**: the " +
          "editor shows the draft so the user can choose which fields to vary before saving. The " +
          "shape of every member comes from the plugin's own `getCreateConfig`: a captured value " +
          "with no matching create field is dropped, and a resource type the plugin cannot create " +
          "is reported in `skipped` with a reason rather than silently omitted. Recorded output " +
          "references whose target is also in the selection are preserved as `output` field " +
          "values; a value that is exactly another selected resource's external id becomes a " +
          "`member-id`.",
      )
      .annotate(SuccessDescription, "The draft template")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("listTemplates", "/templates", {
      params: OrgParams,
      success: EnvironmentTemplateList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List environment templates")
      .annotate(SuccessDescription, "The organization's templates"),
    HttpApiEndpoint.post("createTemplate", "/templates", {
      params: OrgParams,
      payload: EnvironmentTemplateInput,
      success: EnvironmentTemplate.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, EnvironmentTemplateConflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create an environment template")
      .annotate(
        OpenApi.Description,
        "Save a capture draft as a template. Member keys must be unique, every parameter and " +
          "member reference must resolve, and the members must be orderable; a dependency cycle " +
          "is rejected here rather than half-way through an apply. Audit-logged.",
      )
      .annotate(SuccessDescription, "The created template")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("getTemplate", "/templates/:templateId", {
      params: TemplateParams,
      success: EnvironmentTemplate,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get an environment template")
      .annotate(SuccessDescription, "The template"),
    HttpApiEndpoint.put("updateTemplate", "/templates/:templateId", {
      params: TemplateParams,
      payload: EnvironmentTemplateInput,
      success: EnvironmentTemplate,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Replace an environment template")
      .annotate(
        OpenApi.Description,
        "The whole document is replaced. Live instances are unaffected. Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated template")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("deleteTemplate", "/templates/:templateId", {
      params: TemplateParams,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete an environment template")
      .annotate(
        OpenApi.Description,
        "Live instances keep running and keep their TTL; they own real resources, and the " +
          "template is only where they came from. Their `templateId` becomes null; the " +
          "denormalized `templateName` is what the surface reads. Audit-logged.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("estimate", "/templates/:templateId/estimate", {
      params: TemplateParams,
      payload: EstimateRequest,
      success: EnvironmentCostEstimate,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Price an instantiation before it runs")
      .annotate(
        OpenApi.Description,
        "Runs each member's create fields through the plugin's own `estimateCost`. A member the " +
          "plugin cannot price is counted in `unpricedCount` and makes the total `partial`: " +
          "`null` is never rounded to zero.",
      )
      .annotate(SuccessDescription, "The forward-looking estimate")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("instantiate", "/templates/:templateId/instantiate", {
      params: TemplateParams,
      payload: InstantiateRequest,
      success: EnvironmentInstance.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Forbidden, NotFound, EnvironmentInstanceConflict, ChangeFreezeBlocked],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Stamp out an environment")
      .annotate(
        OpenApi.Description,
        "Creates the template's resources in dependency order through the ordinary " +
          "`createResource` path, name-prefixed per instance, and attaches an auto-delete lease " +
          "to each so expiry runs through the existing lease pass. `ttlHours` is **required**. " +
          "Requires `resources:write` **and** `resources:delete` (the lease is a standing " +
          "deletion, the same rule `POST /leases` applies), and is blocked by an active change " +
          "freeze. A create that fails part-way returns a `partial` instance whose created " +
          "members are recorded and tearable-down, never an error with orphaned resources behind " +
          "it. Audit-logged.",
      )
      .annotate(SuccessDescription, "The instance: check `status` for `partial`")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("listInstances", "/instances", {
      params: OrgParams,
      success: EnvironmentInstanceList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List environment instances")
      .annotate(
        OpenApi.Description,
        "Newest first. Reading this also reconciles instances past their deadline against what " +
          "the lease pass already deleted, so an environment whose resources are all gone stops " +
          "reporting itself as running.",
      )
      .annotate(SuccessDescription, "The organization's instances"),
    HttpApiEndpoint.get("getInstance", "/instances/:instanceId", {
      params: InstanceParams,
      success: EnvironmentInstance,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get an environment instance")
      .annotate(SuccessDescription, "The instance"),
    HttpApiEndpoint.post("teardown", "/instances/:instanceId/teardown", {
      params: InstanceParams,
      success: EnvironmentInstance,
      error: [NotFound, ChangeFreezeBlocked],
    })
      .annotate(RequiredPermission, "resources:delete")
      .annotate(OpenApi.Summary, "Tear an environment down now")
      .annotate(
        OpenApi.Description,
        "Deletes every created member through the ordinary `deleteResource` path, in reverse " +
          "creation order. Idempotent: a member already gone, a resource the provider answers " +
          "404 for, and an instance already torn down all succeed quietly, so this is safe to " +
          "retry. Blocked by an active change freeze. Audit-logged.",
      )
      .annotate(
        SuccessDescription,
        "The instance: `partial` when some member could not be deleted",
      ),
    HttpApiEndpoint.delete("deleteInstance", "/instances/:instanceId", {
      params: InstanceParams,
      success: HttpApiSchema.NoContent,
      error: [NotFound, EnvironmentStillLive],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Forget a torn-down environment")
      .annotate(
        OpenApi.Description,
        "Removes the record. Refuses while the instance still owns resources; the row is the " +
          "only thing that knows they exist. Audit-logged.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/environments")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Ephemeral environments") {}

export class EnvironmentsApi extends withApiDefaults(
  HttpApi.make("environments").add(EnvironmentsGroup),
) {}
