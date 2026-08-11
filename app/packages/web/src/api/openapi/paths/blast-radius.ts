import { z } from "../zod";
import { strict, OrgIdParam, ResourceId } from "../common";
import type { BuildContext } from "../context";

const BlastRadiusNode = strict({
  id: ResourceId,
  displayName: z.string(),
  pluginId: z.string(),
  pluginDisplayName: z.string(),
  pluginLogoSvg: z.string().openapi({ description: "Inline SVG markup; may be empty." }),
  resourceTypeId: z.string(),
  resourceTypeLabel: z.string(),
  accountId: z.string(),
  accountName: z.string(),
}).openapi("BlastRadiusNode");

const BlastRadiusVia = strict({
  fieldKey: z.string().openapi({ description: "The dependant's field holding the reference." }),
  outputKey: z.string().openapi({ description: "The output or identity the reference reads." }),
  kind: z.enum(["output-ref", "declared", "containment", "field-match"]).optional().openapi({
    description: "Where the edge came from. Absent means `output-ref` — a reference wired by hand.",
  }),
  label: z.string().optional().openapi({
    description: 'How the plugin words the relationship ("in VPC"), when it declared one.',
  }),
});

const BlastRadiusDependant = strict({
  node: BlastRadiusNode,
  depth: z
    .number()
    .int()
    .openapi({
      description:
        "Shortest hop count from the resource: 1 is a direct dependant, 2 or more reached it " +
        "through something else. The resource itself is never listed.",
    }),
  via: BlastRadiusVia.optional().openapi({
    description:
      "How a direct dependant reaches the resource. Absent for transitive dependants, whose " +
      "path is several edges and has no single caption.",
  }),
}).openapi("BlastRadiusDependant");

const BlastRadiusReference = strict({
  kind: z
    .enum([
      "dashboard",
      "custom-graph",
      "probe",
      "status-page",
      "metric-alert",
      "lease",
      "schedule",
      "workflow",
      "log-query",
      "owner",
    ])
    .openapi({ description: "What kind of object names the resource." }),
  id: z.string().openapi({ description: "The referring object's own id." }),
  name: z.string(),
  detail: z.string().optional().openapi({ description: "One extra clause of context." }),
  userFacing: z
    .boolean()
    .optional()
    .openapi({
      description:
        "Set when the reference is visible outside the organization — a published status page " +
        "component, or the probe behind one. Any user-facing reference makes the report high " +
        "severity on its own.",
    }),
}).openapi("BlastRadiusReference");

const BlastRadiusFlowPeer = strict({
  ref: z.string().openapi({
    description: "The peer's flow ref — a provider resource id, or a class token like `internet`.",
  }),
  label: z.string(),
  direction: z.enum(["egress", "ingress"]).openapi({
    description: "Relative to the resource being deleted, not to the row the provider captured.",
  }),
  scope: z.string().openapi({ description: "The boundary the traffic crossed." }),
  bytes: z.number(),
  estimatedCost: z.number(),
  currency: z.string(),
  days: z.number().int().openapi({
    description: "Days in the window this peer appeared on — a spike versus a standing flow.",
  }),
  resourceId: ResourceId.nullable().openapi({
    description:
      "The peer's Infrawrench resource id when its flow ref resolved to a synced resource; " +
      "null when it did not.",
  }),
}).openapi("BlastRadiusFlowPeer");

const BlastRadiusGap = strict({
  kind: z.enum([
    "network-flows",
    "dependency-graph",
    "references",
    "workflow-source",
    "custom-graph-source",
  ]),
  reason: z.string().openapi({
    description: "A full sentence, written to be rendered verbatim to the person deleting.",
  }),
}).openapi("BlastRadiusGap");

const BlastRadiusReport = strict({
  resourceId: ResourceId,
  resource: BlastRadiusNode.nullable().openapi({
    description: "The resource itself, when it participates in the dependency graph.",
  }),
  dependants: z.array(BlastRadiusDependant).openapi({
    description: "Affected resources, direct first then by depth.",
  }),
  directCount: z.number().int(),
  transitiveCount: z.number().int(),
  references: z.array(BlastRadiusReference).openapi({
    description: "Objects naming the resource without depending on it, user-facing ones first.",
  }),
  flowPeers: z.array(BlastRadiusFlowPeer).openapi({
    description:
      "Measured network peers over the last 14 days, heaviest first. Empty when flow " +
      "collection is off — see `unchecked`.",
  }),
  flowTotals: strict({
    bytes: z.number(),
    estimatedCost: z.number(),
    currency: z.string(),
  })
    .nullable()
    .openapi({
      description:
        "Totals over `flowPeers`, or null when traffic could not be measured at all. Zeroed " +
        "totals mean collection is on and the resource is quiet; null means nobody looked.",
    }),
  unchecked: z.array(BlastRadiusGap).openapi({
    description:
      "What the report could not look at. An empty `dependants` list with a non-empty " +
      "`unchecked` list is not a clean bill of health, and surfaces must not render it as one.",
  }),
  severity: z.enum(["none", "low", "medium", "high", "unknown"]).openapi({
    description:
      "`high` for anything user-facing or five or more direct dependants; `unknown` when " +
      "nothing was found but something could not be checked.",
  }),
  headline: z.string().openapi({ description: "One sentence, ready to render." }),
}).openapi("BlastRadiusReport");

export function registerBlastRadiusPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/blast-radius",
    tags: ["Associations"],
    summary: "What breaks if this resource is deleted",
    description:
      "An impact report for one resource, assembled from the dependency graph walked inbound, " +
      "network flow attribution, and the org objects that name the resource without depending " +
      "on it (dashboards, custom graphs, probes, status pages, metric alerts, leases, " +
      "schedules, saved log queries, workflows, and its recorded owner).\n\n" +
      "The endpoint answers 200 with a partial report rather than failing when a source is " +
      "unavailable; `unchecked` says which, in prose.",
    request: {
      params: OrgIdParam,
      query: strict({
        resourceId: ResourceId.openapi({
          description:
            "The resource to report on. A query parameter rather than a path segment because " +
            "composite resource ids contain slashes and colons.",
        }),
      }),
    },
    responses: {
      200: {
        description: "The impact report",
        content: { "application/json": { schema: BlastRadiusReport } },
      },
      400: { description: "Missing resourceId" },
    },
  });
}
