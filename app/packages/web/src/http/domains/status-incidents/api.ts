/**
 * Provider status correlation: `/api/org/:orgId/status-incidents`, the
 * endpoint definitions.
 *
 * Reads the same resource set the incidents are matched against, so it rides
 * `resources:read`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams } from "../../schemas/common";

const NonNegativeInt = (description: string) =>
  Schema.Int.annotate({ description }).check(Schema.isGreaterThanOrEqualTo(0));

const ProviderIncidentImpact = Schema.Literals([
  "maintenance",
  "minor",
  "major",
  "critical",
]).annotate({
  identifier: "ProviderIncidentImpact",
  description: "Normalized incident severity, least to most severe.",
});

const ProviderIncidentState = Schema.Literals([
  "investigating",
  "identified",
  "monitoring",
  "resolved",
]).annotate({
  identifier: "ProviderIncidentState",
  description: "Normalized incident lifecycle state as the provider reports it.",
});

const ProviderIncidentResourceSample = Schema.Struct({
  id: Schema.String.annotate({ description: "Resource id." }),
  displayName: Schema.String,
  resourceTypeId: Schema.String,
  region: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description: "The resource's region field, when it has one.",
    }),
  ),
}).annotate({ identifier: "ProviderIncidentResourceSample" });

const OrgStatusIncident = Schema.Struct({
  id: Schema.String.annotate({ description: "Cached incident row id." }),
  /** Plain string, not the live plugin enum: the cache may reference a plugin since removed. */
  pluginId: Schema.String,
  pluginName: Schema.String.annotate({
    description: 'Provider display name, e.g. "DigitalOcean".',
  }),
  title: Schema.String,
  state: ProviderIncidentState,
  impact: ProviderIncidentImpact,
  url: Schema.NullOr(Schema.String).annotate({
    description: "Deep link to the provider's incident page or status page.",
  }),
  startedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  lastUpdateAt: Schema.NullOr(IsoDateTime),
  lastUpdateText: Schema.NullOr(Schema.String).annotate({
    description: "Plain-text body of the provider's most recent update.",
  }),
  regions: Schema.Array(Schema.String).annotate({
    description: "Plugin-native region ids the provider reports as affected.",
  }),
  services: Schema.Array(Schema.String).annotate({
    description: "Human-readable affected provider services/products.",
  }),
  providerWide: Schema.Boolean.annotate({
    description: "True when the incident affects the provider as a whole.",
  }),
  affectedResourceCount: NonNegativeInt(
    "How many of the organization's resources the incident overlaps.",
  ),
  affectedRegions: Schema.Array(Schema.String).annotate({
    description: "The subset of `regions` where the organization actually holds resources.",
  }),
  sampleResources: Schema.Array(ProviderIncidentResourceSample).annotate({
    description: "Up to five of the overlapped resources, for display.",
  }),
  overlappingChangeCount: NonNegativeInt(
    "Change-timeline events recorded on this provider during the incident window; " +
      '"these N changes happened during an incident".',
  ),
}).annotate({ identifier: "OrgStatusIncident" });

export const OrgStatusIncidentsResponse = Schema.Struct({
  incidents: Schema.Array(OrgStatusIncident),
}).annotate({ identifier: "OrgStatusIncidentsResponse" });

export class StatusIncidentsGroup extends HttpApiGroup.make("statusIncidents")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: OrgStatusIncidentsResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Provider incidents overlapping your resources")
      .annotate(
        OpenApi.Description,
        'The "is it me or is it them?" feed. The poller watches each provider plugin\'s public ' +
          "status feed (declared on its manifest; zero credentials, zero rate-limit risk), caches " +
          "active incidents, and this endpoint correlates them against the resources the " +
          "organization holds: an incident matches a resource when it is provider-wide, names the " +
          "resource's region, or names its resource type. Includes incidents resolved within the " +
          "last 24 hours so recent drift can still be correlated. Active incidents first, most " +
          "severe first.",
      )
      .annotate(SuccessDescription, "Incidents correlated with the organization's resources"),
  )
  .prefix("/api/org/:orgId/status-incidents")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Status incidents") {}

export class StatusIncidentsApi extends withApiDefaults(
  HttpApi.make("statusIncidents").add(StatusIncidentsGroup),
) {}
