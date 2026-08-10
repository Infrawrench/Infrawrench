import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const ProviderIncidentImpact = z
  .enum(["maintenance", "minor", "major", "critical"])
  .openapi("ProviderIncidentImpact", {
    description: "Normalized incident severity, least to most severe.",
  });

const ProviderIncidentState = z
  .enum(["investigating", "identified", "monitoring", "resolved"])
  .openapi("ProviderIncidentState", {
    description: "Normalized incident lifecycle state as the provider reports it.",
  });

const ProviderIncidentResourceSample = strict({
  id: z.string().openapi({ description: "Resource id." }),
  displayName: z.string(),
  resourceTypeId: z.string(),
  region: z.string().nullable().optional().openapi({
    description: "The resource's region field, when it has one.",
  }),
}).openapi("ProviderIncidentResourceSample");

const OrgStatusIncident = strict({
  id: z.string().openapi({ description: "Cached incident row id." }),
  /** Plain string, not the live plugin enum: the cache may reference a plugin since removed. */
  pluginId: z.string(),
  pluginName: z.string().openapi({ description: 'Provider display name, e.g. "DigitalOcean".' }),
  title: z.string(),
  state: ProviderIncidentState,
  impact: ProviderIncidentImpact,
  url: z.string().nullable().openapi({
    description: "Deep link to the provider's incident page or status page.",
  }),
  startedAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
  lastUpdateAt: IsoDateTime.nullable(),
  lastUpdateText: z.string().nullable().openapi({
    description: "Plain-text body of the provider's most recent update.",
  }),
  regions: z.array(z.string()).openapi({
    description: "Plugin-native region ids the provider reports as affected.",
  }),
  services: z.array(z.string()).openapi({
    description: "Human-readable affected provider services/products.",
  }),
  providerWide: z.boolean().openapi({
    description: "True when the incident affects the provider as a whole.",
  }),
  affectedResourceCount: z.number().int().nonnegative().openapi({
    description: "How many of the organization's resources the incident overlaps.",
  }),
  affectedRegions: z.array(z.string()).openapi({
    description: "The subset of `regions` where the organization actually holds resources.",
  }),
  sampleResources: z.array(ProviderIncidentResourceSample).openapi({
    description: "Up to five of the overlapped resources, for display.",
  }),
  overlappingChangeCount: z
    .number()
    .int()
    .nonnegative()
    .openapi({
      description:
        "Change-timeline events recorded on this provider during the incident window — " +
        '"these N changes happened during an incident".',
    }),
}).openapi("OrgStatusIncident");

const OrgStatusIncidentsResponse = strict({
  incidents: z.array(OrgStatusIncident),
}).openapi("OrgStatusIncidentsResponse");

export function registerStatusIncidentPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/status-incidents",
    tags: ["Status incidents"],
    summary: "Provider incidents overlapping your resources",
    description:
      'The "is it me or is it them?" feed. The poller watches each provider plugin\'s public ' +
      "status feed (declared on its manifest — zero credentials, zero rate-limit risk), caches " +
      "active incidents, and this endpoint correlates them against the resources the " +
      "organization holds: an incident matches a resource when it is provider-wide, names the " +
      "resource's region, or names its resource type. Includes incidents resolved within the " +
      "last 24 hours so recent drift can still be correlated. Active incidents first, most " +
      "severe first.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Incidents correlated with the organization's resources",
        content: { "application/json": { schema: OrgStatusIncidentsResponse } },
      },
      400: ErrorResponses[400],
    },
  });
}
