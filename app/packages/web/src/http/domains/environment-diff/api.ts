/**
 * Environment diff: `/api/org/:orgId/environment-diff`, the endpoint
 * definitions.
 *
 * The comparison lives in server-core (`environment-diff.ts`) over the pure
 * `computeEnvironmentDiff` in client-core, so the web view, the desktop panel
 * and `infrawrench diff` all read the same computation. Purely a read over
 * already-synced state: `resources:read` only.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs } from "../../schemas/documented";
import { PluginId } from "../../schemas/plugin-registry";

const EnvironmentDiffStatus = Schema.Literals(["only-in-a", "only-in-b", "changed"]).annotate({
  description:
    "Whether the slot exists on side A only, side B only, or on both with a field divergence. " +
    "Matched pairs that agree are counted in the type summary rather than listed.",
});

/**
 * Any JSON value, with a description. Effect documents `Schema.Unknown` as
 * `{}` and drops its annotations; `Schema.Any` keeps them. Only ever a
 * response field checked by `respond`, so its `any` type reaches no code.
 */
const describedValue = (description: string) => Schema.Any.annotate({ description });

const EnvironmentDiffFieldChange = Schema.Struct({
  field: Schema.String.annotate({
    description: "Field key; resolved-output keys are prefixed `outputs.`.",
    examples: ["instanceClass"],
  }),
  // Optional on the wire: a key removed on side B leaves `to` undefined,
  // which JSON drops.
  a: Schema.optionalKey(describedValue("Value on side A; null when the key is absent there.")),
  b: Schema.optionalKey(describedValue("Value on side B.")),
}).annotate({ identifier: "EnvironmentDiffFieldChange" });

const EnvironmentDiffResourceRef = Schema.Struct({
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id." }),
  accountId: Uuid,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String).annotate({
    description: "Provider-native id, when known.",
  }),
}).annotate({ identifier: "EnvironmentDiffResourceRef" });

const EnvironmentDiffEntry = Schema.Struct({
  key: Schema.String.annotate({
    description:
      "The pairing key both sides matched on; the resource type plus the resource name with " +
      "environment words removed. Stable across runs.",
    examples: ["droplet api#0"],
  }),
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["Droplet"] }),
  status: EnvironmentDiffStatus,
  a: Schema.NullOr(EnvironmentDiffResourceRef).annotate({
    description: "Null when the resource exists only on B.",
  }),
  b: Schema.NullOr(EnvironmentDiffResourceRef).annotate({
    description: "Null when the resource exists only on A.",
  }),
  changes: Schema.Array(EnvironmentDiffFieldChange).annotate({
    description: "Field divergences. Empty unless `status` is `changed`.",
  }),
  suppressedCount: Schema.Int.annotate({
    description:
      "Divergences hidden by the identity filter (ids, links, addresses, timestamps). Always " +
      "0 when `includeIdentityFields` was requested.",
  }),
}).annotate({ identifier: "EnvironmentDiffEntry" });

const EnvironmentDiffTypeSummary = Schema.Struct({
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  countA: Schema.Int,
  countB: Schema.Int,
  delta: Schema.Int.annotate({ description: "`countB - countA`." }),
  onlyInA: Schema.Int,
  onlyInB: Schema.Int,
  changed: Schema.Int.annotate({
    description: "Matched pairs that disagree on at least one field.",
  }),
  identical: Schema.Int.annotate({ description: "Matched pairs with no visible divergence." }),
  missingFrom: Schema.NullOr(Schema.Literals(["a", "b"])).annotate({
    description: "Set when the resource type is absent from that side entirely.",
  }),
}).annotate({ identifier: "EnvironmentDiffTypeSummary" });

const EnvironmentDiffSideSummary = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  resourceCount: Schema.Int.annotate({ description: "Resources compared on this side." }),
}).annotate({ identifier: "EnvironmentDiffSideSummary" });

const EnvironmentDiffTotals = Schema.Struct({
  onlyInA: Schema.Int,
  onlyInB: Schema.Int,
  changed: Schema.Int,
  identical: Schema.Int,
  typesOnlyInA: Schema.Int,
  typesOnlyInB: Schema.Int,
  suppressedFieldChanges: Schema.Int.annotate({
    description: "Field divergences the identity filter hid across every pair.",
  }),
}).annotate({ identifier: "EnvironmentDiffTotals" });

const EnvironmentDiffUnavailableType = Schema.Struct({
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  message: Schema.String.annotate({
    description: "The provider's complaint, as the lister reported it.",
  }),
}).annotate({ identifier: "EnvironmentDiffUnavailableType" });

export const EnvironmentDiffResponse = Schema.Struct({
  a: EnvironmentDiffSideSummary,
  b: EnvironmentDiffSideSummary,
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["DigitalOcean"] }),
  types: Schema.Array(EnvironmentDiffTypeSummary).annotate({
    description: "Every resource type present on either side, most-divergent first.",
  }),
  entries: Schema.Array(EnvironmentDiffEntry).annotate({
    description: "Only the slots that differ; identical pairs are counted, not listed.",
  }),
  totals: EnvironmentDiffTotals,
  unavailableTypes: Schema.Array(EnvironmentDiffUnavailableType).annotate({
    description:
      "Resource types excluded because they could not be listed. Always empty over this API; " +
      "it reads already-synced rows, which cannot half-fail; and populated only by the " +
      "desktop and CLI local modes, which list live.",
  }),
  includeIdentityFields: Schema.Boolean,
  generatedAt: IsoDateTime,
}).annotate({ identifier: "EnvironmentDiffResponse" });

/**
 * `true` or `false`, documented as that enum. Not checked: the route has only
 * ever compared it with `"true"`, so any other value means false.
 */
const BooleanFlag = documentedAs(Schema.Literals(["true", "false"]));

export class EnvironmentDiffGroup extends HttpApiGroup.make("environmentDiff")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      query: {
        a: Uuid.annotate({
          description: "Baseline account id; by convention the environment that works.",
        }),
        b: Uuid.annotate({
          description: "Compared account id. Must differ from `a` and use the same provider.",
        }),
        resourceTypeId: Schema.optionalKey(
          Schema.String.annotate({ description: "Compare one resource type only." }),
        ),
        includeIdentityFields: Schema.optionalKey(
          BooleanFlag.annotate({
            description:
              "Compare identity and timestamp fields too, instead of filtering them out.",
          }),
        ),
      },
      success: EnvironmentDiffResponse,
      // Missing/equal account ids, or two accounts on different providers.
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Compare two accounts' resource inventories")
      .annotate(
        OpenApi.Description,
        "Compares two accounts of the same provider (typically staging against production) over " +
          "already-synced state: which resource types exist in one and not the other, the per-type " +
          "count deltas, and the fields on which two corresponding resources disagree (instance " +
          "class, engine version, feature flags).\n\n" +
          "Resources are paired by resource type plus name with environment words removed, so " +
          "`api-staging` lines up with `api-prod` without any naming convention to configure. By " +
          "default the comparison hides divergences that are artefacts of being two different " +
          "resources (ids, links, network addresses and timestamps) because every resource has " +
          "different ones; pass `includeIdentityFields=true` to see them.\n\n" +
          "Read-only and cheap: no provider API calls are made, so results reflect the last sync.",
      )
      .annotate(SuccessDescription, "The two inventories compared")
      .annotate(InvalidRequestMessage, "Both a and b account ids are required"),
  )
  .prefix("/api/org/:orgId/environment-diff")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Environment diff") {}

export class EnvironmentDiffApi extends withApiDefaults(
  HttpApi.make("environment-diff").add(EnvironmentDiffGroup),
) {}
