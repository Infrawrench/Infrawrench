/**
 * HTTP API for custom graphs (org-scoped, mounted at /api/org/:orgId/custom-graphs).
 *
 * CRUD plus: GET /typings (the static graph.d.ts for the Monaco editor),
 * POST /check (headless type check of arbitrary source), and
 * POST /:id/render (run the script in the isolate and return the render spec).
 *
 * The logic lives in services/custom-graphs.ts so the MCP/chat tool registry
 * drives exactly the same code path; this file is transport only. Writes and
 * renders are paid-plan-gated in the service (402 via PlanRequiredError).
 *
 * NOTE: like workflows, custom graphs reuse the dashboards:read /
 * dashboards:write permissions — they are dashboard content.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import { requirePermission } from "../../auth/permissions";
import {
  CustomGraphError,
  checkCustomGraphSource,
  createCustomGraph,
  generateCustomGraphTypings,
  getCustomGraph,
  listCustomGraphs,
  renderOrgCustomGraph,
  softDeleteCustomGraph,
  updateCustomGraph,
  type CustomGraphBody,
} from "../../services/custom-graphs";
import { PlanRequiredError } from "../../services/entitlements";

const app = new Hono();

function orgId(c: Context): string {
  return c.get("organizationId") as string;
}

/** Map a service-level failure onto its HTTP response. */
function fail(c: Context, e: unknown) {
  if (e instanceof CustomGraphError) return c.json({ error: e.message }, e.status);
  if (e instanceof PlanRequiredError) return c.json({ error: e.message }, 402);
  throw e;
}

const controlStateSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(500), z.number(), z.boolean()]),
);

const renderRequestSchema = z.object({
  controls: controlStateSchema.optional(),
  button: z.string().max(64).optional(),
  trigger: z.enum(["manual", "refresh", "interaction"]).optional(),
});

app.get("/", async (c) => {
  requirePermission(c, "dashboards:read");
  const rows = await listCustomGraphs(orgId(c));
  // The list is for pickers and sidebars — no need to ship every source blob.
  return c.json(
    rows.map(({ id, name, description, createdAt, updatedAt }) => ({
      id,
      name,
      description,
      createdAt,
      updatedAt,
    })),
  );
});

app.post("/", async (c) => {
  requirePermission(c, "dashboards:write");
  const body = (await c.req.json()) as CustomGraphBody;
  const userId = (c.get("session") as { userId?: string } | undefined)?.userId;
  try {
    return c.json(await createCustomGraph(orgId(c), body, userId), 201);
  } catch (e) {
    return fail(c, e);
  }
});

// Org-specific: the graph half is static, the appended read-only infra half
// reflects this org's connected accounts.
app.get("/typings", async (c) => {
  requirePermission(c, "dashboards:read");
  return c.text(await generateCustomGraphTypings(orgId(c)));
});

app.post("/check", async (c) => {
  requirePermission(c, "dashboards:read");
  const { source } = (await c.req.json()) as { source?: string };
  if (typeof source !== "string") return c.json({ error: "source is required" }, 400);
  return c.json(await checkCustomGraphSource(orgId(c), source));
});

app.get("/:id", async (c) => {
  requirePermission(c, "dashboards:read");
  const row = await getCustomGraph(orgId(c), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

app.put("/:id", async (c) => {
  requirePermission(c, "dashboards:write");
  const body = (await c.req.json()) as CustomGraphBody;
  const userId = (c.get("session") as { userId?: string } | undefined)?.userId;
  try {
    return c.json(await updateCustomGraph(orgId(c), c.req.param("id"), body, userId));
  } catch (e) {
    return fail(c, e);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "dashboards:write");
  try {
    await softDeleteCustomGraph(orgId(c), c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return fail(c, e);
  }
});

app.post("/:id/render", async (c) => {
  requirePermission(c, "dashboards:read");
  const parsed = renderRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid render request", issues: parsed.error.issues }, 400);
  }
  try {
    return c.json(
      await renderOrgCustomGraph(orgId(c), c.req.param("id"), {
        ...(parsed.data.controls ? { controls: parsed.data.controls } : {}),
        ...(parsed.data.button ? { button: parsed.data.button } : {}),
        ...(parsed.data.trigger ? { trigger: parsed.data.trigger } : {}),
      }),
    );
  } catch (e) {
    return fail(c, e);
  }
});

export { app as customGraphRoutes };
