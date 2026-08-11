import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

/**
 * **IaC reconciliation** — the ClickOps detector.
 *
 * The org uploads the Terraform state it already has; every synced resource is
 * classified managed / drifted / unmanaged, and the unmanaged ones can be
 * turned into `import` blocks. Not to be confused with the three other
 * "Terraform" surfaces: eject-to-Terraform (`POST
 * /resources/{pluginId}/{typeId}/export-terraform`) writes HCL describing the
 * user's cloud resources, org config as code moves a whole org as one JSON
 * document, and the `terraform-provider-infrawrench` provider manages
 * Infrawrench's own configuration through the org-scoped routes.
 */
export function registerIacPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const IacState = strict({
    id: Uuid,
    label: z.string().describe('User-supplied name for this state, e.g. "prod / us-east-1".'),
    accountId: Uuid.nullable().describe(
      "The account this state covers, or null when it covers the whole organization.",
    ),
    accountName: z.string().nullable(),
    format: z
      .enum(["tfstate", "show-json"])
      .describe("Which document shape was uploaded: a raw state file, or `terraform show -json`."),
    formatVersion: z
      .string()
      .describe('The document\'s own version — "4" for a state file, "1.0"-style otherwise.'),
    terraformVersion: z.string().nullable(),
    serial: z.number().int().nullable().describe("State file serial; null for show output."),
    lineage: z.string().nullable().describe("State file lineage; null for show output."),
    resourceCount: z.number().int().describe("Managed resource instances recorded."),
    dataSourceCount: z
      .number()
      .int()
      .describe("Data-source entries, recorded but never matched against inventory."),
    redactedAttributeCount: z
      .number()
      .int()
      .describe(
        "Attribute values dropped because the state marked them sensitive. Redaction happens at parse time — no sensitive value is ever stored.",
      ),
    parseWarnings: z.array(z.string()),
    uploadedByUserId: Uuid.nullable(),
    uploadedByName: z.string().nullable(),
    createdAt: IsoDateTime,
  }).openapi("IacState");

  const IacStateList = strict({ states: z.array(IacState) }).openapi("IacStateListResponse");

  const IacStateUpload = strict({
    label: z.string().min(1).max(120),
    accountId: Uuid.nullable().optional(),
    document: z
      .string()
      .describe(
        "The state document, as text: a raw `.tfstate` (format version 4) or the output of `terraform show -json` (format_version 1.x). Limited to 8 MiB.",
      ),
  }).openapi("IacStateUploadRequest");

  const IacFieldChange = strict({
    field: z.string(),
    from: z.unknown().describe("The value Terraform state carries."),
    to: z.unknown().describe("The value actually running."),
  }).openapi("IacFieldChange");

  const IacReconciledResource = strict({
    resourceId: z.string(),
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    accountId: Uuid,
    displayName: z.string(),
    externalId: z.string().nullable(),
    status: z
      .enum(["managed", "drifted", "unmanaged"])
      .describe(
        "`managed`: matched a state entry and agrees with it. `drifted`: matched, but live fields differ. `unmanaged`: in inventory, absent from state — somebody made it by hand.",
      ),
    terraformType: z.string().nullable(),
    terraformAddress: z.string().nullable(),
    matchedBy: z
      .enum(["import-id", "external-id", "identifier"])
      .nullable()
      .describe("How the match was made, so it can be argued with."),
    drift: z.array(IacFieldChange),
    unmappableReason: z
      .string()
      .nullable()
      .describe(
        'Set when no Terraform block could be produced for this resource, which makes its drift unknowable. Never reported as "no drift".',
      ),
    owner: z
      .object({})
      .passthrough()
      .nullable()
      .describe("Resource owner annotation, populated for unmanaged resources."),
    firstSeenAt: IsoDateTime.nullable().describe(
      "When the change timeline first recorded this resource appearing.",
    ),
  }).openapi("IacReconciledResource");

  const IacStateOnlyResource = strict({
    address: z.string(),
    terraformType: z.string(),
    identifiers: z.array(z.string()),
    candidates: z.array(strict({ pluginId: enums.PluginId, resourceTypeId: z.string() })),
    reason: z.enum(["no-inventory-match", "unknown-terraform-type"]),
  }).openapi("IacStateOnlyResource");

  const IacReconciliation = strict({
    state: IacState,
    resources: z.array(IacReconciledResource),
    stateOnly: z
      .array(IacStateOnlyResource)
      .describe("State entries with no inventory match — their own category."),
    summary: strict({
      inventoryTotal: z.number().int(),
      managed: z.number().int(),
      drifted: z.number().int(),
      unmanaged: z.number().int(),
      stateOnly: z.number().int(),
      undiffable: z.number().int(),
      stateResources: z.number().int(),
      dataSourcesIgnored: z.number().int(),
    }),
    underivable: z
      .array(strict({ pluginId: enums.PluginId, resourceTypeId: z.string(), reason: z.string() }))
      .describe(
        "Plugin resource types whose Terraform type could not be derived from the plugin's own export mapper. Reported rather than guessed.",
      ),
  }).openapi("IacReconciliationResponse");

  const IacImportPlanRequest = strict({
    resourceIds: z.array(z.string()).min(1).max(500),
  }).openapi("IacImportPlanRequest");

  const IacImportPlan = strict({
    hcl: z.string().describe("`import` blocks followed by the generated resource stanzas."),
    exported: z.array(
      strict({ resourceId: z.string(), address: z.string(), importId: z.string().nullable() }),
    ),
    unsupported: z.array(
      strict({ resourceId: z.string(), displayName: z.string(), reason: z.string() }),
    ),
  }).openapi("IacImportPlanResponse");

  const IacResourceStatus = strict({
    status: z.enum(["managed", "drifted", "unmanaged"]).nullable(),
    stateId: Uuid.nullable(),
    stateLabel: z.string().nullable(),
    terraformAddress: z.string().nullable(),
    driftFieldCount: z.number().int(),
  }).openapi("IacResourceStatusResponse");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/iac/states",
    tags: ["IaC"],
    summary: "List uploaded Terraform state documents",
    description:
      "Every state document the organization has uploaded, newest first. The documents themselves are never stored — only the parsed, redacted projection.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's state documents",
        content: { "application/json": { schema: IacStateList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/iac/states",
    tags: ["IaC"],
    summary: "Upload a Terraform state document",
    description:
      "Parses a `.tfstate` (format version 4) or `terraform show -json` output (format_version 1.x) and records the resource instances it contains. Attributes the state marks sensitive are dropped before anything is written. The format version is checked, not assumed: an unsupported version is a 400 rather than a partial read.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: IacStateUpload } } },
    },
    responses: {
      201: {
        description: "The stored state document",
        content: { "application/json": { schema: strict({ state: IacState }) } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/iac/states/{stateId}",
    tags: ["IaC"],
    summary: "Delete an uploaded state document",
    request: {
      params: OrgIdParam.extend({
        stateId: Uuid.openapi({ param: { name: "stateId", in: "path" } }),
      }),
    },
    responses: { 204: { description: "Deleted" }, 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/iac/reconciliation",
    tags: ["IaC"],
    summary: "Classify inventory against a state document",
    description:
      'Every synced resource classified as managed, drifted or unmanaged against one uploaded state, plus state entries with no inventory match. Unmanaged resources carry the ownership and first-seen join that answers "who made this by hand, and when".',
    request: {
      params: OrgIdParam,
      query: strict({
        stateId: Uuid.openapi({ param: { name: "stateId", in: "query" } }),
      }),
    },
    responses: {
      200: {
        description: "The classification",
        content: { "application/json": { schema: IacReconciliation } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/iac/import-plan",
    tags: ["IaC"],
    summary: "Generate Terraform import blocks for unmanaged resources",
    description:
      'Terraform 1.5+ `import` blocks plus the matching resource stanzas, generated by the same plugin export mappers and HCL serializer that back "Export to Terraform…". Resources no plugin can express are returned in `unsupported` with a reason, never dropped.',
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: IacImportPlanRequest } } },
    },
    responses: {
      200: {
        description: "The adoption document",
        content: { "application/json": { schema: IacImportPlan } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/iac/resource",
    tags: ["IaC"],
    summary: "IaC status for one resource",
    description:
      "The managed/unmanaged badge for a resource detail page, computed against the newest state document. `status` is null when the organization has uploaded none — absence of a state is not evidence of ClickOps. A query parameter rather than a path segment because composite resource ids contain slashes.",
    request: {
      params: OrgIdParam,
      query: strict({
        resourceId: z.string().openapi({ param: { name: "resourceId", in: "query" } }),
      }),
    },
    responses: {
      200: {
        description: "The resource's IaC status",
        content: { "application/json": { schema: IacResourceStatus } },
      },
      400: ErrorResponses[400],
    },
  });
}
