/**
 * IaC reconciliation, the ClickOps detector: `/api/org/:orgId/iac`, the
 * endpoint definitions.
 *
 * The org uploads the Terraform state it already has; every synced resource
 * is classified managed / drifted / unmanaged, and the unmanaged ones can be
 * turned into `import` blocks. Not to be confused with the three other
 * "Terraform" surfaces: eject-to-Terraform writes HCL describing the user's
 * cloud resources, org config as code moves a whole org as one JSON
 * document, and `terraform-provider-infrawrench` manages Infrawrench's own
 * configuration. The VS Code and Raycast extensions call these routes.
 *
 * Reading is `iac:read`; uploading and deleting are `iac:write`.
 */
import { Predicate, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { IAC_LIMITS } from "@infrawrench/client-core";
import { maxLength, minLength } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { documentedAs, optionalRequestBody, requiredQuery } from "../http/schemas/documented";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { PluginId } from "../http/schemas/plugin-registry";

/** A free-form object, documented as the hand-written spec had it (`properties: {}`). */
const OpenObject = Schema.Any.pipe(
  Schema.refine(Predicate.isObject, { toJsonSchema: () => ({ type: "object", properties: {} }) }),
);

export const IacState = Schema.Struct({
  id: Uuid,
  label: Schema.String.annotate({
    description: 'User-supplied name for this state, e.g. "prod / us-east-1".',
  }),
  accountId: Schema.NullOr(Uuid).annotate({
    description: "The account this state covers, or null when it covers the whole organization.",
  }),
  accountName: Schema.NullOr(Schema.String),
  format: Schema.Literals(["tfstate", "show-json"]).annotate({
    description: "Which document shape was uploaded: a raw state file, or `terraform show -json`.",
  }),
  formatVersion: Schema.String.annotate({
    description: 'The document\'s own version; "4" for a state file, "1.0"-style otherwise.',
  }),
  terraformVersion: Schema.NullOr(Schema.String),
  serial: Schema.NullOr(Schema.Int).annotate({
    description: "State file serial; null for show output.",
  }),
  lineage: Schema.NullOr(Schema.String).annotate({
    description: "State file lineage; null for show output.",
  }),
  resourceCount: Schema.Int.annotate({ description: "Managed resource instances recorded." }),
  dataSourceCount: Schema.Int.annotate({
    description: "Data-source entries, recorded but never matched against inventory.",
  }),
  redactedAttributeCount: Schema.Int.annotate({
    description:
      "Attribute values dropped because the state marked them sensitive. Redaction happens at parse time; no sensitive value is ever stored.",
  }),
  parseWarnings: Schema.Array(Schema.String),
  uploadedByUserId: Schema.NullOr(Uuid),
  uploadedByName: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
}).annotate({ identifier: "IacState" });

export const IacStateList = Schema.Struct({ states: Schema.Array(IacState) }).annotate({
  identifier: "IacStateListResponse",
});

export const IacStateCreated = Schema.Struct({ state: IacState });

/**
 * The upload as the route validates it. `accountId` is documented as a UUID
 * and never checked as one (an id that is not one finds no account).
 */
const IacStateUpload = Schema.Struct({
  label: Schema.String.check(minLength(1), maxLength(IAC_LIMITS.maxLabelChars)),
  accountId: Schema.optionalKey(Schema.NullOr(Uuid)),
  document: Schema.String.check(minLength(1)).annotate({
    description:
      "The state document, as text: a raw `.tfstate` (format version 4) or the output of `terraform show -json` (format_version 1.x). Limited to 8 MiB.",
  }),
}).annotate({ identifier: "IacStateUploadRequest" });

const IacFieldChange = Schema.Struct({
  field: Schema.String,
  from: Schema.optionalKey(Schema.Unknown).annotateKey({
    description: "The value Terraform state carries.",
  }),
  to: Schema.optionalKey(Schema.Unknown).annotateKey({
    description: "The value actually running.",
  }),
}).annotate({ identifier: "IacFieldChange" });

const IacReconciledResource = Schema.Struct({
  resourceId: Schema.String,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["managed", "drifted", "unmanaged"]).annotate({
    description:
      "`managed`: matched a state entry and agrees with it. `drifted`: matched, but live fields differ. `unmanaged`: in inventory, absent from state; somebody made it by hand.",
  }),
  terraformType: Schema.NullOr(Schema.String),
  terraformAddress: Schema.NullOr(Schema.String),
  matchedBy: Schema.NullOr(Schema.Literals(["import-id", "external-id", "identifier"])).annotate({
    description: "How the match was made, so it can be argued with.",
  }),
  drift: Schema.Array(IacFieldChange),
  unmappableReason: Schema.NullOr(Schema.String).annotate({
    description:
      'Set when no Terraform block could be produced for this resource, which makes its drift unknowable. Never reported as "no drift".',
  }),
  owner: Schema.NullOr(OpenObject).annotate({
    description: "Resource owner annotation, populated for unmanaged resources.",
  }),
  firstSeenAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the change timeline first recorded this resource appearing.",
  }),
}).annotate({ identifier: "IacReconciledResource" });

const IacStateOnlyResource = Schema.Struct({
  address: Schema.String,
  terraformType: Schema.String,
  identifiers: Schema.Array(Schema.String),
  candidates: Schema.Array(Schema.Struct({ pluginId: PluginId, resourceTypeId: Schema.String })),
  reason: Schema.Literals(["no-inventory-match", "unknown-terraform-type"]),
}).annotate({ identifier: "IacStateOnlyResource" });

export const IacReconciliation = Schema.Struct({
  state: IacState,
  resources: Schema.Array(IacReconciledResource),
  stateOnly: Schema.Array(IacStateOnlyResource).annotate({
    description: "State entries with no inventory match, their own category.",
  }),
  summary: Schema.Struct({
    inventoryTotal: Schema.Int,
    managed: Schema.Int,
    drifted: Schema.Int,
    unmanaged: Schema.Int,
    stateOnly: Schema.Int,
    undiffable: Schema.Int,
    stateResources: Schema.Int,
    dataSourcesIgnored: Schema.Int,
  }),
  underivable: Schema.Array(
    Schema.Struct({ pluginId: PluginId, resourceTypeId: Schema.String, reason: Schema.String }),
  ).annotate({
    description:
      "Plugin resource types whose Terraform type could not be derived from the plugin's own export mapper. Reported rather than guessed.",
  }),
}).annotate({ identifier: "IacReconciliationResponse" });

const IacImportPlanRequest = Schema.Struct({
  resourceIds: Schema.Array(Schema.String.check(minLength(1))).check(
    minLength(1),
    maxLength(IAC_LIMITS.maxImportPlanResources),
  ),
}).annotate({ identifier: "IacImportPlanRequest" });

export const IacImportPlan = Schema.Struct({
  hcl: Schema.String.annotate({
    description: "`import` blocks followed by the generated resource stanzas.",
  }),
  exported: Schema.Array(
    Schema.Struct({
      resourceId: Schema.String,
      address: Schema.String,
      importId: Schema.NullOr(Schema.String),
    }),
  ),
  unsupported: Schema.Array(
    Schema.Struct({ resourceId: Schema.String, displayName: Schema.String, reason: Schema.String }),
  ),
}).annotate({ identifier: "IacImportPlanResponse" });

export const IacResourceStatus = Schema.Struct({
  status: Schema.NullOr(Schema.Literals(["managed", "drifted", "unmanaged"])),
  stateId: Schema.NullOr(Uuid),
  stateLabel: Schema.NullOr(Schema.String),
  terraformAddress: Schema.NullOr(Schema.String),
  driftFieldCount: Schema.Int,
}).annotate({ identifier: "IacResourceStatusResponse" });

export class IacGroup extends HttpApiGroup.make("iac")
  .add(
    HttpApiEndpoint.get("listStates", "/states", {
      params: OrgParams,
      success: IacStateList,
    })
      .annotate(RequiredPermission, "iac:read")
      .annotate(OpenApi.Summary, "List uploaded Terraform state documents")
      .annotate(
        OpenApi.Description,
        "Every state document the organization has uploaded, newest first. The documents themselves are never stored; only the parsed, redacted projection.",
      )
      .annotate(SuccessDescription, "The organization's state documents"),
    HttpApiEndpoint.post("uploadState", "/states", {
      params: OrgParams,
      payload: IacStateUpload,
      success: IacStateCreated.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "iac:write")
      .annotate(OpenApi.Summary, "Upload a Terraform state document")
      .annotate(
        OpenApi.Description,
        "Parses a `.tfstate` (format version 4) or `terraform show -json` output (format_version 1.x) and records the resource instances it contains. Attributes the state marks sensitive are dropped before anything is written. The format version is checked, not assumed: an unsupported version is a 400 rather than a partial read.",
      )
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(InvalidRequestMessage, "Invalid body")
      .annotate(SuccessDescription, "The stored state document"),
    HttpApiEndpoint.delete("deleteState", "/states/:stateId", {
      params: { orgId: OrgId, stateId: Uuid },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "iac:write")
      .annotate(OpenApi.Summary, "Delete an uploaded state document")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("reconciliation", "/reconciliation", {
      params: OrgParams,
      // Read as sent, so a missing id is the handler's own 400.
      query: { stateId: Schema.optionalKey(documentedAs(Uuid)) },
      success: IacReconciliation,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "iac:read")
      .annotate(OpenApi.Summary, "Classify inventory against a state document")
      .annotate(
        OpenApi.Description,
        'Every synced resource classified as managed, drifted or unmanaged against one uploaded state, plus state entries with no inventory match. Unmanaged resources carry the ownership and first-seen join that answers "who made this by hand, and when".',
      )
      .annotate(OpenApi.Transform, requiredQuery(["stateId"]))
      .annotate(SuccessDescription, "The classification"),
    HttpApiEndpoint.post("importPlan", "/import-plan", {
      params: OrgParams,
      payload: IacImportPlanRequest,
      success: IacImportPlan,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "iac:read")
      .annotate(OpenApi.Summary, "Generate Terraform import blocks for unmanaged resources")
      .annotate(
        OpenApi.Description,
        'Terraform 1.5+ `import` blocks plus the matching resource stanzas, generated by the same plugin export mappers and HCL serializer that back "Export to Terraform…". Resources no plugin can express are returned in `unsupported` with a reason, never dropped.',
      )
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(InvalidRequestMessage, "Invalid body")
      .annotate(SuccessDescription, "The adoption document"),
    // A query parameter rather than a path segment because composite resource
    // ids contain slashes (same reason as the change feed's `/changes/resource`).
    HttpApiEndpoint.get("resource", "/resource", {
      params: OrgParams,
      query: { resourceId: Schema.optionalKey(documentedAs(Schema.String)) },
      success: IacResourceStatus,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "iac:read")
      .annotate(OpenApi.Summary, "IaC status for one resource")
      .annotate(
        OpenApi.Description,
        "The managed/unmanaged badge for a resource detail page, computed against the newest state document. `status` is null when the organization has uploaded none; absence of a state is not evidence of ClickOps. A query parameter rather than a path segment because composite resource ids contain slashes.",
      )
      .annotate(OpenApi.Transform, requiredQuery(["resourceId"]))
      .annotate(SuccessDescription, "The resource's IaC status"),
  )
  .prefix("/api/org/:orgId/iac")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "IaC") {}

export class IacApi extends withApiDefaults(HttpApi.make("iac").add(IacGroup)) {}
