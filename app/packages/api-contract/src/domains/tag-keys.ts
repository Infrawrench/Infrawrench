/**
 * Tag keys: `/api/org/:orgId/tag-keys`, the endpoint definitions.
 *
 * Every tag key the org's data carries, and the hidden and preferred lists
 * that order every tag picker. Readable on `resources:read` (the cost half of
 * the listing only for callers who also hold `costs:read`); the settings are
 * org-settings gated, since they change what every member's pickers offer.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { TagKeySettings } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { OrgParams } from "../http/schemas/common";

const DiscoveredTagKey = Schema.Struct({
  key: Schema.String,
  providers: Schema.Array(Schema.String).annotate({
    description: "Plugin ids whose cost rows or resources carry the key.",
  }),
  sources: Schema.Array(Schema.Literals(["costs", "resources"])),
  costRowCount: Schema.Int.annotate({
    description: "Cost rows in the lookback window carrying the key.",
  }),
  costResourceCount: Schema.Int.annotate({
    description: "Distinct billed resource ids among those rows.",
  }),
  inventoryCount: Schema.Int.annotate({
    description: "Synced resources whose tags or labels carry the key (newest 2,000 scanned).",
  }),
  lastSeen: Schema.NullOr(Schema.String).annotate({
    description: "Most recent cost day carrying the key; null when only in the inventory.",
  }),
  hidden: Schema.Boolean,
  hiddenBy: Schema.NullOr(Schema.String).annotate({
    description: "The hidden entry (exact key or prefix pattern) that matched.",
  }),
  preferred: Schema.Boolean,
}).annotate({ identifier: "DiscoveredTagKey" });

export const DiscoveredTagKeys = Schema.Struct({
  keys: Schema.Array(DiscoveredTagKey),
  settings: TagKeySettings,
  lookbackDays: Schema.Int,
  truncated: Schema.Boolean,
}).annotate({ identifier: "DiscoveredTagKeys" });

export class TagKeysGroup extends HttpApiGroup.make("tagKeys")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: DiscoveredTagKeys,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Discovered tag keys with usage")
      .annotate(
        OpenApi.Description,
        "Every tag key the org's cost data (trailing 90 days) and resource inventory carry, with " +
          "the providers using it, row and resource counts, and whether the tag key settings hide " +
          "or pin it. Preferred keys first, then by usage. Cost counts are included only when the " +
          "caller also holds `costs:read`.",
      )
      .annotate(SuccessDescription, "Discovered tag keys"),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: TagKeySettings,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "The org's hidden and preferred tag keys")
      .annotate(SuccessDescription, "Tag key settings"),
    HttpApiEndpoint.put("setSettings", "/settings", {
      params: OrgParams,
      payload: TagKeySettings,
      success: TagKeySettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Replace the org's hidden and preferred tag keys")
      .annotate(
        OpenApi.Description,
        "Applied to every tag-key listing the API serves (`GET /costs/dimensions?dimension=" +
          "tag-keys`, the metric alert selector options, the MCP tools): preferred keys first, " +
          "hidden keys omitted. A display preference only; no stored data changes.",
      )
      .annotate(SuccessDescription, "Saved")
      .annotate(InvalidRequestMessage, "Invalid tag key settings"),
  )
  .prefix("/api/org/:orgId/tag-keys")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Tag Policy") {}

export class TagKeysApi extends withApiDefaults(HttpApi.make("tag-keys").add(TagKeysGroup)) {}
