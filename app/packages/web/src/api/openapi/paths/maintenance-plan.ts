import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const MaintenanceIntent = z.enum(["stop", "restart", "start"]).openapi({
  description:
    "What is being done, which is what decides the direction. `stop` and `restart` go dependants " +
    "first — drain what sits in front before what sits behind it goes away. `start` goes " +
    "dependencies first, so nothing comes up looking for something that is not there yet.",
});

export function registerMaintenancePlanPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const MaintenanceImpact = strict({
    resourceId: z.string(),
    label: z.string(),
    viaResourceId: z.string(),
  }).openapi("MaintenanceImpact");

  const MaintenanceStep = strict({
    position: z.number().int(),
    resourceIds: z
      .array(z.string())
      .describe(
        "More than one means they are independent **of each other within the selection** and may " +
          "be done together. That is the value of computing waves rather than a flat list: twelve " +
          "services with three real layers is three steps, not twelve.",
      ),
    labels: z.array(z.string()),
    affectsOutside: z
      .array(MaintenanceImpact)
      .describe(
        "Resources outside the selection that depend on something in this step — the collateral " +
          "nobody remembers until it happens. Empty for a `start`: listing dependants there would " +
          "read as a warning about a recovery.",
      ),
  }).openapi("MaintenanceStep");

  const MaintenancePlan = strict({
    intent: MaintenanceIntent,
    steps: z.array(MaintenanceStep),
    cyclic: z
      .array(MaintenanceImpact)
      .describe(
        "Selected resources in a dependency cycle, which have no safe order. Reported, **never " +
          "silently linearised**: a cycle means the graph disagrees with itself, and an arbitrary " +
          "order presented as a plan is a guess wearing a plan's clothes.",
      ),
    unknown: z
      .array(z.string())
      .describe(
        "Selected ids not in the graph — usually since deleted. Named rather than dropped, so a " +
          "plan for twelve things never quietly becomes a plan for ten.",
      ),
    partialGraph: z
      .boolean()
      .describe(
        "The dependency graph was truncated, so the plan is a best effort over a partial topology.",
      ),
  }).openapi("MaintenancePlan");

  const MaintenancePlanRequest = strict({
    intent: MaintenanceIntent,
    resourceIds: z.array(z.string()).max(200),
  }).openapi("MaintenancePlanRequest");

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/maintenance-plan",
    tags: ["Maintenance plan"],
    summary: "What order to touch these resources in",
    description:
      '"Restart these twelve services" hides the only hard question in it: in what order? Get it ' +
      "wrong and the app comes back before the database it needs, or the load balancer is drained " +
      "after the thing behind it already stopped. The dependency graph knows, and nothing has " +
      "asked it before.\n\n" +
      "The ordering is Kahn's algorithm over the sub-graph **induced by the selection** — an edge " +
      "through a resource nobody selected does not order two that were.\n\n" +
      "**It plans and does not execute.** There is no companion route that stops anything, and " +
      "that is a boundary rather than an omission: an unattended sequence of destructive actions " +
      "against production is not something to do off a heuristic. Each step links to the " +
      "resources, and the operator acts.\n\n" +
      "A POST that changes nothing, because two hundred resource ids is a request body rather " +
      "than a query string. Takes `resources:read`: working out the order is a planning act, and " +
      "the person writing the change request is routinely not the one who will run it.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: MaintenancePlanRequest } } },
    },
    responses: {
      200: {
        description: "The ordered plan",
        content: { "application/json": { schema: MaintenancePlan } },
      },
      400: ErrorResponses[400],
    },
  });
}
