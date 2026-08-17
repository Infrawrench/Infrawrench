/**
 * Maintenance plan route (`POST /api/org/:orgId/maintenance-plan`).
 *
 * A POST that changes nothing, because the input is a list of resource ids and
 * a maintenance window can cover two hundred of them — which is a request body,
 * not a query string.
 *
 * It **plans and does not execute**. There is no companion route that stops
 * anything, and that is a boundary rather than an omission: an unattended
 * sequence of destructive actions against somebody's production is not
 * something this product should do off a heuristic. The ordering is the part
 * people get wrong, and it is what this answers.
 *
 * `resources:read`, therefore. Working out what order to restart things in is a
 * planning act, and the person writing the change request is routinely not the
 * person who will run it — the same argument blast radius makes for its own
 * permission.
 */
import { Hono } from "hono";
import {
  MAINTENANCE_LIMITS,
  buildMaintenancePlan,
  type MaintenanceIntent,
} from "@infrawrench/client-core";

import { loadDependencyGraph } from "../../services/dependency-graph";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const INTENTS: MaintenanceIntent[] = ["stop", "restart", "start"];

app.post("/", async (c) => {
  requirePermission(c, "resources:read");

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await c.req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return c.json({ error: "Request body must be an object" }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const intent = body["intent"];
  if (typeof intent !== "string" || !INTENTS.includes(intent as MaintenanceIntent)) {
    return c.json({ error: `intent must be one of ${INTENTS.join(", ")}` }, 400);
  }
  const raw = body["resourceIds"];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    return c.json({ error: "resourceIds must be an array of strings" }, 400);
  }
  if (raw.length > MAINTENANCE_LIMITS.maxSelection) {
    return c.json(
      {
        error: `A plan may cover at most ${MAINTENANCE_LIMITS.maxSelection} resources. Beyond that it is a migration, not maintenance.`,
      },
      400,
    );
  }

  // The org-wide graph, like blast radius asks for: the endpoint's
  // `?resourceId=` answer is one hop deep by design, and an ordering cannot be
  // built from it.
  const graph = await loadDependencyGraph(c.get("organizationId"), null);

  return c.json(
    buildMaintenancePlan({
      intent: intent as MaintenanceIntent,
      resourceIds: raw as string[],
      nodes: graph.nodes,
      edges: graph.edges,
      truncated: graph.truncated,
    }),
  );
});

export { app as maintenancePlanRoutes };
