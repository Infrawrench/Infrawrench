import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const EnvironmentDiffStatus = z.enum(["only-in-a", "only-in-b", "changed"]).openapi({
  description:
    "Whether the slot exists on side A only, side B only, or on both with a field divergence. " +
    "Matched pairs that agree are counted in the type summary rather than listed.",
});

export function registerEnvironmentDiffPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const EnvironmentDiffFieldChange = strict({
    field: z
      .string()
      .describe("Field key; resolved-output keys are prefixed `outputs.`.")
      .openapi({ example: "instanceClass" }),
    a: z.unknown().describe("Value on side A; null when the key is absent there."),
    b: z.unknown().describe("Value on side B."),
  }).openapi("EnvironmentDiffFieldChange");

  const EnvironmentDiffResourceRef = strict({
    resourceId: z.string().describe("Infrawrench resource id."),
    accountId: Uuid,
    displayName: z.string(),
    externalId: z.string().nullable().describe("Provider-native id, when known."),
  }).openapi("EnvironmentDiffResourceRef");

  const EnvironmentDiffEntry = strict({
    key: z
      .string()
      .describe(
        "The pairing key both sides matched on — the resource type plus the resource name with " +
          "environment words removed. Stable across runs.",
      )
      .openapi({ example: "droplet api#0" }),
    resourceTypeId: z.string(),
    resourceTypeName: z.string().openapi({ example: "Droplet" }),
    status: EnvironmentDiffStatus,
    a: EnvironmentDiffResourceRef.nullable().describe("Null when the resource exists only on B."),
    b: EnvironmentDiffResourceRef.nullable().describe("Null when the resource exists only on A."),
    changes: z
      .array(EnvironmentDiffFieldChange)
      .describe("Field divergences. Empty unless `status` is `changed`."),
    suppressedCount: z
      .number()
      .int()
      .describe(
        "Divergences hidden by the identity filter (ids, links, addresses, timestamps). Always " +
          "0 when `includeIdentityFields` was requested.",
      ),
  }).openapi("EnvironmentDiffEntry");

  const EnvironmentDiffTypeSummary = strict({
    resourceTypeId: z.string(),
    resourceTypeName: z.string(),
    countA: z.number().int(),
    countB: z.number().int(),
    delta: z.number().int().describe("`countB - countA`."),
    onlyInA: z.number().int(),
    onlyInB: z.number().int(),
    changed: z.number().int().describe("Matched pairs that disagree on at least one field."),
    identical: z.number().int().describe("Matched pairs with no visible divergence."),
    missingFrom: z
      .enum(["a", "b"])
      .nullable()
      .describe("Set when the resource type is absent from that side entirely."),
  }).openapi("EnvironmentDiffTypeSummary");

  const EnvironmentDiffSideSummary = strict({
    accountId: Uuid,
    accountName: z.string(),
    resourceCount: z.number().int().describe("Resources compared on this side."),
  }).openapi("EnvironmentDiffSideSummary");

  const EnvironmentDiffTotals = strict({
    onlyInA: z.number().int(),
    onlyInB: z.number().int(),
    changed: z.number().int(),
    identical: z.number().int(),
    typesOnlyInA: z.number().int(),
    typesOnlyInB: z.number().int(),
    suppressedFieldChanges: z
      .number()
      .int()
      .describe("Field divergences the identity filter hid across every pair."),
  }).openapi("EnvironmentDiffTotals");

  const EnvironmentDiffUnavailableType = strict({
    resourceTypeId: z.string(),
    resourceTypeName: z.string(),
    message: z.string().describe("The provider's complaint, as the lister reported it."),
  }).openapi("EnvironmentDiffUnavailableType");

  const EnvironmentDiffResponse = strict({
    a: EnvironmentDiffSideSummary,
    b: EnvironmentDiffSideSummary,
    pluginId: enums.PluginId,
    pluginName: z.string().openapi({ example: "DigitalOcean" }),
    types: z
      .array(EnvironmentDiffTypeSummary)
      .describe("Every resource type present on either side, most-divergent first."),
    entries: z
      .array(EnvironmentDiffEntry)
      .describe("Only the slots that differ; identical pairs are counted, not listed."),
    totals: EnvironmentDiffTotals,
    unavailableTypes: z
      .array(EnvironmentDiffUnavailableType)
      .describe(
        "Resource types excluded because they could not be listed. Always empty over this API — " +
          "it reads already-synced rows, which cannot half-fail — and populated only by the " +
          "desktop and CLI local modes, which list live.",
      ),
    includeIdentityFields: z.boolean(),
    generatedAt: IsoDateTime,
  }).openapi("EnvironmentDiffResponse");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/environment-diff",
    tags: ["Environment diff"],
    summary: "Compare two accounts' resource inventories",
    description:
      "Compares two accounts of the same provider — typically staging against production — over " +
      "already-synced state: which resource types exist in one and not the other, the per-type " +
      "count deltas, and the fields on which two corresponding resources disagree (instance " +
      "class, engine version, feature flags).\n\n" +
      "Resources are paired by resource type plus name with environment words removed, so " +
      "`api-staging` lines up with `api-prod` without any naming convention to configure. By " +
      "default the comparison hides divergences that are artefacts of being two different " +
      "resources — ids, links, network addresses and timestamps — because every resource has " +
      "different ones; pass `includeIdentityFields=true` to see them.\n\n" +
      "Read-only and cheap: no provider API calls are made, so results reflect the last sync.",
    request: {
      params: OrgIdParam,
      query: strict({
        a: Uuid.openapi({
          param: { name: "a", in: "query" },
          description: "Baseline account id — by convention the environment that works.",
        }),
        b: Uuid.openapi({
          param: { name: "b", in: "query" },
          description: "Compared account id. Must differ from `a` and use the same provider.",
        }),
        resourceTypeId: z
          .string()
          .optional()
          .openapi({
            param: { name: "resourceTypeId", in: "query" },
            description: "Compare one resource type only.",
          }),
        includeIdentityFields: z
          .enum(["true", "false"])
          .optional()
          .openapi({
            param: { name: "includeIdentityFields", in: "query" },
            description:
              "Compare identity and timestamp fields too, instead of filtering them out.",
          }),
      }),
    },
    responses: {
      200: {
        description: "The two inventories compared",
        content: { "application/json": { schema: EnvironmentDiffResponse } },
      },
      // Missing/equal account ids, or two accounts on different providers.
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
