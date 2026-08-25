import { Hono, type Context } from "hono";
import {
  StatusPageInputError,
  createStatusPageRecord,
  deleteStatusPageRecord,
  getPublicStatusPage,
  listStatusPages,
  rotateStatusPageSlugRecord,
  updateStatusPageRecord,
} from "@infrawrench/server-core/status-pages/store";
import type {
  StatusPageComponentInput,
  StatusPageCreate,
  StatusPagePatch,
} from "@infrawrench/client-core";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

/**
 * Public status pages — the org's synthetic probes, published at an
 * unauthenticated URL.
 *
 * This module exports **two** routers, and keeping them apart is the point:
 *
 * - `statusPageRoutes` is mounted inside the org tree and manages the rows.
 *   Permissions ride the probes stance (`resources:read` / `resources:write`):
 *   a status page is a view over probes, and whoever may create the monitoring
 *   may decide what of it is public.
 * - `publicStatusRoutes` is mounted **outside** every auth middleware, because
 *   its whole purpose is to answer callers who have no account. It takes no
 *   credentials, reads no session, and can only ever reach
 *   `getPublicStatusPage`, which assembles a payload with no org identifiers
 *   in it.
 */

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

interface ParsedBody {
  body: Record<string, unknown>;
  error?: Response;
}

async function parseObjectBody(c: Context): Promise<ParsedBody> {
  try {
    const parsed = (await c.req.json()) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { body: {}, error: c.json({ error: "Request body must be an object" }, 400) };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { body: {}, error: c.json({ error: "Invalid JSON body" }, 400) };
  }
}

function statusPageErrorResponse(c: Context, err: unknown) {
  if (err instanceof StatusPageInputError) {
    return c.json({ error: err.message }, err.status);
  }
  console.error("[status-pages] unexpected error:", err);
  return c.json({ error: "Status page operation failed" }, 500);
}

/** Parse the `components` array, or return the boundary's complaint. */
function readComponents(
  raw: unknown,
): { ok: true; components: StatusPageComponentInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "components must be an array" };
  const components: StatusPageComponentInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: "Each component must be an object" };
    }
    const item = entry as Record<string, unknown>;
    if (typeof item["probeId"] !== "string" || !item["probeId"]) {
      return { ok: false, error: "Each component needs a probeId" };
    }
    const label = item["label"];
    const groupName = item["groupName"];
    if (label !== undefined && label !== null && typeof label !== "string") {
      return { ok: false, error: "Component label must be a string" };
    }
    if (groupName !== undefined && groupName !== null && typeof groupName !== "string") {
      return { ok: false, error: "Component groupName must be a string" };
    }
    components.push({
      probeId: item["probeId"],
      ...(label !== undefined ? { label: label as string | null } : {}),
      ...(groupName !== undefined ? { groupName: groupName as string | null } : {}),
    });
  }
  return { ok: true, components };
}

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listStatusPages(c.get("organizationId")));
});

// No `GET /:id`: the list already returns every page in full, components and
// all, so a single-page read would be a second way to say the same thing.

app.post("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  if (typeof body["title"] !== "string") return c.json({ error: "title is required" }, 400);

  let components: StatusPageComponentInput[] | undefined;
  if (body["components"] !== undefined) {
    const parsed = readComponents(body["components"]);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    components = parsed.components;
  }

  const input: StatusPageCreate = {
    title: body["title"],
    ...(typeof body["description"] === "string" || body["description"] === null
      ? { description: body["description"] as string | null }
      : {}),
    ...(typeof body["published"] === "boolean" ? { published: body["published"] } : {}),
    ...(typeof body["showHistory"] === "boolean" ? { showHistory: body["showHistory"] } : {}),
    ...(typeof body["showUptime"] === "boolean" ? { showUptime: body["showUptime"] } : {}),
    ...(typeof body["supportUrl"] === "string" || body["supportUrl"] === null
      ? { supportUrl: body["supportUrl"] as string | null }
      : {}),
    ...(components ? { components } : {}),
  };

  try {
    const created = await createStatusPageRecord(organizationId, input, session?.userId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "status_page.create",
      entityType: "status_page",
      entityId: created.id,
      metadata: { title: created.title, published: created.published },
    });
    return c.json(created, 201);
  } catch (err) {
    return statusPageErrorResponse(c, err);
  }
});

app.put("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const pageId = c.req.param("id");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;

  let components: StatusPageComponentInput[] | undefined;
  if (body["components"] !== undefined) {
    const parsed = readComponents(body["components"]);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    components = parsed.components;
  }

  const patch: StatusPagePatch = {
    ...(typeof body["title"] === "string" ? { title: body["title"] } : {}),
    ...(typeof body["description"] === "string" || body["description"] === null
      ? { description: body["description"] as string | null }
      : {}),
    ...(typeof body["published"] === "boolean" ? { published: body["published"] } : {}),
    ...(typeof body["showHistory"] === "boolean" ? { showHistory: body["showHistory"] } : {}),
    ...(typeof body["showUptime"] === "boolean" ? { showUptime: body["showUptime"] } : {}),
    ...(typeof body["supportUrl"] === "string" || body["supportUrl"] === null
      ? { supportUrl: body["supportUrl"] as string | null }
      : {}),
    ...(components ? { components } : {}),
  };

  try {
    const updated = await updateStatusPageRecord(organizationId, pageId, patch);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "status_page.update",
      entityType: "status_page",
      entityId: updated.id,
      // Publishing is the state change that matters in an audit trail — it is
      // the moment the page became readable by anyone with the link.
      metadata: { published: updated.published, componentCount: updated.components.length },
    });
    return c.json(updated);
  } catch (err) {
    return statusPageErrorResponse(c, err);
  }
});

/** POST /:id/rotate-slug — revoke the current public URL, issue a new one. */
app.post("/:id/rotate-slug", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const rotated = await rotateStatusPageSlugRecord(organizationId, c.req.param("id"));
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "status_page.rotate_slug",
      entityType: "status_page",
      entityId: rotated.id,
    });
    return c.json(rotated);
  } catch (err) {
    return statusPageErrorResponse(c, err);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const removed = await deleteStatusPageRecord(organizationId, c.req.param("id"));
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "status_page.delete",
      entityType: "status_page",
      entityId: removed.id,
      metadata: { title: removed.title },
    });
    return c.body(null, 204);
  } catch (err) {
    return statusPageErrorResponse(c, err);
  }
});

/**
 * The public reader. Mounted outside the org tree and outside every auth
 * middleware — see the module note.
 *
 * An unpublished page and a nonexistent slug answer the same 404, so the
 * endpoint cannot be used to probe which slugs are real.
 *
 * Caching is short and public on purpose: a status page is exactly the thing
 * that gets hammered during an incident, and a minute of CDN cache is the
 * difference between the page absorbing that traffic and the database doing
 * it. A minute is also short enough that a recovery shows up promptly.
 */
const publicApp = new Hono();

publicApp.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  try {
    const page = await getPublicStatusPage(slug);
    if (!page) return c.json({ error: "Status page not found" }, 404);
    c.header("Cache-Control", "public, max-age=60");
    // No account, no org — nothing here is per-user, and a search engine
    // indexing a status page someone was given privately is not intended.
    c.header("X-Robots-Tag", "noindex");
    return c.json(page);
  } catch (err) {
    console.error("[status-pages] public read failed:", err);
    return c.json({ error: "Status page unavailable" }, 500);
  }
});

export { app as statusPageRoutes, publicApp as publicStatusRoutes };
