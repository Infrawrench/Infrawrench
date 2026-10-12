import { Hono, type Context } from "hono";
import {
  SERVICE_LIMITS,
  isServiceTier,
  type ServiceInput,
  type ServiceLink,
  type ServiceMembershipRule,
} from "@infrawrench/client-core";
import {
  ServiceInputError,
  addServiceMembers,
  createServiceRecord,
  deleteServiceRecord,
  getServiceRecord,
  getServiceWire,
  listServicesWire,
  removeServiceMember,
  restoreExcludedMember,
  updateServiceRecord,
} from "@infrawrench/server-core/service-catalog/store";
import { getServicesForResources } from "@infrawrench/server-core/service-catalog/lookup";
import { buildServiceSummary } from "@infrawrench/server-core/service-catalog/summary";
import { publishServiceChanged } from "@infrawrench/server-core/service-catalog/events";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import {
  ensureDefaultScorecard,
  listScorecardHistory,
  listScorecardResults,
  markScorecardsDue,
} from "@infrawrench/server-core/scorecards/store";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { parseObjectBody } from "../object-body";

/**
 * Services: a logical grouping of resources across providers with an owner,
 * a tier and links to its SLOs, runbooks and on-call schedule. CRUD,
 * membership (explicit members plus rules, with exclusions), the summary the
 * service page renders, and the resource-to-service lookup other features
 * annotate with.
 *
 * Permissions follow the resource ownership stance: reads are
 * `resources:read`, writes `resources:write`. Saying "these resources are the
 * checkout API" is the same kind of statement as "this VM is mine", and
 * gating it on an admin permission would leave services empty.
 *
 * The summary's cost figure reads through the cost visibility store like
 * every cost route, so a scoped member sees only the spend their scope allows.
 */

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function serviceErrorResponse(c: Context, err: unknown) {
  if (err instanceof ServiceInputError) return c.json({ error: err.message }, err.status);
  console.error("[services] unexpected error:", err);
  return c.json({ error: "Service operation failed" }, 500);
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Pick the known fields off a request body, type-checked; unknown keys are ignored. */
function pickServiceBody(body: Record<string, unknown>): Partial<ServiceInput> | string {
  const out: Partial<ServiceInput> = {};
  const strOrNull = (k: string) =>
    body[k] === null ? null : typeof body[k] === "string" ? (body[k] as string) : undefined;

  if (typeof body["name"] === "string") out.name = body["name"];
  if (typeof body["slug"] === "string") out.slug = body["slug"];
  const description = strOrNull("description");
  if (description !== undefined) out.description = description;
  if (body["tier"] !== undefined) {
    if (body["tier"] !== null && !isServiceTier(body["tier"]))
      return "tier must be 1, 2, 3, 4 or null";
    out.tier = body["tier"] as ServiceInput["tier"];
  }
  const ownerTeam = strOrNull("ownerTeam");
  if (ownerTeam !== undefined) out.ownerTeam = ownerTeam;
  if (body["ownerUserIds"] !== undefined) {
    if (!isStringArray(body["ownerUserIds"])) return "ownerUserIds must be an array of user ids";
    out.ownerUserIds = body["ownerUserIds"];
  }
  if (body["links"] !== undefined) {
    const links = body["links"];
    if (
      !Array.isArray(links) ||
      !links.every(
        (l) =>
          l &&
          typeof l === "object" &&
          typeof (l as ServiceLink).label === "string" &&
          typeof (l as ServiceLink).url === "string",
      )
    ) {
      return "links must be an array of { label, url }";
    }
    out.links = (links as ServiceLink[]).map((l) => ({ label: l.label, url: l.url }));
  }
  const onCall = strOrNull("onCallScheduleId");
  if (onCall !== undefined) out.onCallScheduleId = onCall;
  if (body["sloIds"] !== undefined) {
    if (!isStringArray(body["sloIds"])) return "sloIds must be an array of SLO ids";
    out.sloIds = body["sloIds"];
  }
  if (body["runbookIds"] !== undefined) {
    if (!isStringArray(body["runbookIds"])) return "runbookIds must be an array of runbook ids";
    out.runbookIds = body["runbookIds"];
  }
  if (body["rules"] !== undefined) {
    if (!Array.isArray(body["rules"]) || !body["rules"].every((r) => r && typeof r === "object")) {
      return "rules must be an array of rule objects";
    }
    out.rules = body["rules"] as ServiceMembershipRule[];
  }
  if (body["monthlyBudget"] !== undefined) {
    const v = body["monthlyBudget"];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
      return "monthlyBudget must be a number or null";
    }
    out.monthlyBudget = v as number | null;
  }
  const currency = strOrNull("budgetCurrency");
  if (currency !== undefined) out.budgetCurrency = currency;
  return out;
}

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json({ services: await listServicesWire(c.get("organizationId")) });
});

/**
 * Which services own these resources. `ids` is a comma-separated list of
 * Infrawrench resource ids; resources in no service are absent from the map.
 */
app.get("/for-resources", async (c) => {
  requirePermission(c, "resources:read");
  const ids = (c.req.query("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length > SERVICE_LIMITS.maxMembersPerRequest) {
    return c.json(
      { error: `Ask about at most ${SERVICE_LIMITS.maxMembersPerRequest} resources at a time` },
      400,
    );
  }
  const map = await getServicesForResources(c.get("organizationId"), ids);
  return c.json({ services: Object.fromEntries(map) });
});

app.get("/:id", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const row = await getServiceRecord(organizationId, c.req.param("id"));
  if (!row) return c.json({ error: "Service not found" }, 404);
  const { service, membership } = await getServiceWire(organizationId, row);
  return c.json({ service, members: membership.members, excluded: membership.excluded });
});

app.get("/:id/summary", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const row = await getServiceRecord(organizationId, c.req.param("id"));
  if (!row) return c.json({ error: "Service not found" }, 404);
  const scorecards = await listScorecardResults(organizationId, { serviceId: row.id });
  return c.json(await buildServiceSummary(organizationId, row, scorecards));
});

app.get("/:id/scorecards", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const row = await getServiceRecord(organizationId, c.req.param("id"));
  if (!row) return c.json({ error: "Service not found" }, 404);
  const [results, history] = await Promise.all([
    listScorecardResults(organizationId, { serviceId: row.id }),
    listScorecardHistory(organizationId, row.id),
  ]);
  return c.json({ results, history });
});

app.post("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const input = pickServiceBody(body);
  if (typeof input === "string") return c.json({ error: input }, 400);
  try {
    const created = await createServiceRecord(organizationId, input, session?.userId);
    await ensureDefaultScorecard(organizationId);
    await markScorecardsDue(organizationId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "service.create",
      entityType: "service",
      entityId: created.id,
      metadata: { name: created.name, slug: created.slug, tier: created.tier },
    });
    void keepAlive(publishServiceChanged(organizationId, created, "created"));
    const { service } = await getServiceWire(organizationId, created);
    return c.json(service, 201);
  } catch (err) {
    return serviceErrorResponse(c, err);
  }
});

app.patch("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const patch = pickServiceBody(body);
  if (typeof patch === "string") return c.json({ error: patch }, 400);
  if (Object.keys(patch).length === 0) return c.json({ error: "No changes supplied" }, 400);
  try {
    const updated = await updateServiceRecord(organizationId, c.req.param("id"), patch);
    await markScorecardsDue(organizationId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "service.update",
      entityType: "service",
      entityId: updated.id,
      metadata: { name: updated.name, fields: Object.keys(patch) },
    });
    void keepAlive(publishServiceChanged(organizationId, updated, "updated", Object.keys(patch)));
    const { service } = await getServiceWire(organizationId, updated);
    return c.json(service);
  } catch (err) {
    return serviceErrorResponse(c, err);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const deleted = await deleteServiceRecord(organizationId, c.req.param("id"));
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "service.delete",
      entityType: "service",
      entityId: deleted.id,
      metadata: { name: deleted.name },
    });
    void keepAlive(publishServiceChanged(organizationId, deleted, "deleted"));
    return c.body(null, 204);
  } catch (err) {
    return serviceErrorResponse(c, err);
  }
});

/** Add resources by hand (or put an excluded one back). */
app.post("/:id/members", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const row = await getServiceRecord(organizationId, c.req.param("id"));
  if (!row) return c.json({ error: "Service not found" }, 404);
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  if (!isStringArray(body["resourceIds"])) {
    return c.json({ error: "resourceIds must be an array of resource ids" }, 400);
  }
  try {
    const added = await addServiceMembers(
      organizationId,
      row.id,
      body["resourceIds"],
      session?.userId,
    );
    await markScorecardsDue(organizationId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "service.members.add",
      entityType: "service",
      entityId: row.id,
      metadata: { name: row.name, count: added, resourceIds: body["resourceIds"].slice(0, 50) },
    });
    void keepAlive(publishServiceChanged(organizationId, row, "updated", ["members"]));
    const { service, membership } = await getServiceWire(organizationId, row);
    return c.json({ service, members: membership.members, excluded: membership.excluded });
  } catch (err) {
    return serviceErrorResponse(c, err);
  }
});

/**
 * Take a resource out. A hand-added member is removed; a rule-matched one is
 * excluded, since the rule would otherwise put it back. Deleting an
 * exclusion (`?restore=1`) lets the rule apply again.
 */
app.delete("/:id/members/:resourceId", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const row = await getServiceRecord(organizationId, c.req.param("id"));
  if (!row) return c.json({ error: "Service not found" }, 404);
  const resourceId = c.req.param("resourceId");
  try {
    let outcome: "removed" | "excluded" | "restored";
    if (c.req.query("restore") === "1") {
      if (!(await restoreExcludedMember(row.id, resourceId))) {
        return c.json({ error: "That resource is not excluded from this service" }, 404);
      }
      outcome = "restored";
    } else {
      outcome = await removeServiceMember(organizationId, row, resourceId, session?.userId);
    }
    await markScorecardsDue(organizationId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: `service.members.${outcome === "restored" ? "restore" : outcome === "excluded" ? "exclude" : "remove"}`,
      entityType: "service",
      entityId: row.id,
      metadata: { name: row.name, resourceId },
    });
    void keepAlive(publishServiceChanged(organizationId, row, "updated", ["members"]));
    const { service, membership } = await getServiceWire(organizationId, row);
    return c.json({ service, members: membership.members, excluded: membership.excluded });
  } catch (err) {
    return serviceErrorResponse(c, err);
  }
});

export { app as serviceRoutes };
