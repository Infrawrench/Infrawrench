/**
 * Org config as code (`/api/org/:orgId/config/*`).
 *
 * Three verbs: `GET /export` produces the document, `POST /plan` says what
 * applying one would do, `POST /apply` does it. The logic lives in
 * `services/org-config/`, so this file is transport plus authorization only.
 *
 * ## Permissions
 *
 * Every route needs `config:read` (export/plan) or `config:write` (apply) —
 * **and** the per-section permission for each section involved. That second
 * check is the point: `config:write` on its own would otherwise be a way around
 * a role that deliberately withholds `workflows:write`, since a document can
 * carry workflow source. A document is only allowed to touch the sections its
 * caller could have edited by hand.
 *
 * Export refuses rather than quietly omitting sections the caller cannot read.
 * A partial document looks complete, and applying it in `replace` mode would
 * delete everything the exporter was not allowed to see.
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import {
  ORG_CONFIG_SECTIONS,
  ORG_CONFIG_SECTION_READ_PERMISSIONS,
  ORG_CONFIG_SECTION_WRITE_PERMISSIONS,
  type OrgConfigSection,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db/client";
import { organizations } from "../../db/schema";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { PlanRequiredError } from "../../services/entitlements";
import {
  OrgConfigError,
  applyOrgConfig,
  exportOrgConfig,
  orgConfigDocumentSections,
  parseOrgConfigDocument,
  planOrgConfig,
} from "../../services/org-config";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function orgId(c: Context): string {
  return c.get("organizationId") as string;
}

/** Map a service-level failure onto its HTTP response. */
function fail(c: Context, e: unknown) {
  if (e instanceof OrgConfigError) return c.json({ error: e.message }, e.status);
  if (e instanceof PlanRequiredError) return c.json({ error: e.message }, 402);
  throw e;
}

/**
 * Require the per-section permission for each section, naming the first one the
 * caller is missing. A 403 that says which section and which permission is the
 * difference between "fix your role" and "guess".
 */
function requireSectionPermissions(
  c: Context,
  sections: readonly OrgConfigSection[],
  table: Record<OrgConfigSection, string>,
): void {
  const granted = c.get("permissions") ?? [];
  for (const section of sections) {
    const permission = table[section];
    if (!hasPermission(granted, permission)) {
      throw new HTTPException(403, {
        message: `Missing permission: ${permission} (required for the "${section}" section)`,
      });
    }
  }
}

/** `?sections=budgets,workflows` — the export's optional narrowing. */
function parseSections(c: Context): OrgConfigSection[] {
  const raw = c.req.query("sections");
  if (!raw) return [...ORG_CONFIG_SECTIONS];
  const wanted = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((s) => !(ORG_CONFIG_SECTIONS as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw new OrgConfigError(
      `Unknown section(s): ${unknown.join(", ")}. Valid sections: ${ORG_CONFIG_SECTIONS.join(", ")}.`,
    );
  }
  return wanted as OrgConfigSection[];
}

async function organizationName(organizationId: string): Promise<string> {
  const [row] = await db
    .select({ name: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.name ?? organizationId;
}

/**
 * GET /api/org/:orgId/config/export — the whole configuration as one document.
 *
 * `?sections=` narrows it. Narrowing matters for more than payload size: a
 * document that carries only `budgets` can be applied in `replace` mode without
 * touching anything else, which is how you keep one file per concern in git.
 */
app.get("/export", async (c) => {
  requirePermission(c, "config:read");
  const organizationId = orgId(c);
  try {
    const sections = parseSections(c);
    requireSectionPermissions(c, sections, ORG_CONFIG_SECTION_READ_PERMISSIONS);
    const document = await exportOrgConfig(organizationId, {
      organizationName: await organizationName(organizationId),
      sections,
    });
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "org_config.export",
      entityType: "org_config",
      entityId: organizationId,
      metadata: { sections },
    });
    return c.json(document);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * POST /api/org/:orgId/config/plan — what applying this document would do.
 *
 * Read-only, so it rides `config:read` plus each named section's *read*
 * permission: previewing a change is not making one, and a reviewer on a PR
 * needs to be able to run it.
 */
app.post("/plan", async (c) => {
  requirePermission(c, "config:read");
  const organizationId = orgId(c);
  try {
    const body = await c.req.json<{ document?: unknown; mode?: unknown }>();
    const mode = body.mode === "replace" ? "replace" : "merge";
    const document = parseOrgConfigDocument(body.document ?? body);
    requireSectionPermissions(
      c,
      orgConfigDocumentSections(document),
      ORG_CONFIG_SECTION_READ_PERMISSIONS,
    );
    return c.json(
      await planOrgConfig(organizationId, document, {
        mode,
        userId: c.get("session").userId ?? null,
      }),
    );
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * POST /api/org/:orgId/config/apply — apply the document, in one transaction.
 *
 * `mode: "replace"` also deletes what the document does not name *within the
 * sections it carries*. It is never the default, and the CLI puts a
 * confirmation in front of it.
 */
app.post("/apply", async (c) => {
  requirePermission(c, "config:write");
  const organizationId = orgId(c);
  try {
    const body = await c.req.json<{ document?: unknown; mode?: unknown }>();
    const mode = body.mode === "replace" ? "replace" : "merge";
    const document = parseOrgConfigDocument(body.document ?? body);
    const sections = orgConfigDocumentSections(document);
    requireSectionPermissions(c, sections, ORG_CONFIG_SECTION_WRITE_PERMISSIONS);

    const result = await applyOrgConfig(organizationId, document, {
      mode,
      userId: c.get("session").userId ?? null,
    });
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "org_config.apply",
      entityType: "org_config",
      entityId: organizationId,
      metadata: {
        mode,
        sections,
        created: result.counts.create,
        updated: result.counts.update,
        deleted: result.counts.delete,
      },
    });
    return c.json(result);
  } catch (e) {
    return fail(c, e);
  }
});

export { app as orgConfigRoutes };
