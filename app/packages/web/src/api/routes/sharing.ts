/**
 * Per-object sharing (`/api/org/:orgId/sharing/:objectType/:objectId`) for
 * cost reports, report folders and dashboards. See
 * `services/object-sharing.ts` for the model.
 *
 * Reading the document needs viewer on the object plus the object family's
 * read permission; replacing it needs owner on the object plus the family's
 * write permission. Errors from the service map in `api/index.ts`'s
 * `onError` (404 below viewer, 403 below owner, 400 for a bad document).
 */
import { Hono } from "hono";
import {
  OBJECT_ACCESS_LEVELS,
  ORG_ACCESS_LEVELS,
  SHAREABLE_OBJECT_TYPES,
  SHARING_GRANT_PRINCIPAL_KINDS,
  type ObjectSharingInput,
  type ShareableObjectType,
} from "@infrawrench/client-core";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import {
  getObjectSharing,
  putObjectSharing,
  resetObjectSharing,
  SharingInputError,
} from "../../services/object-sharing";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
    organizationId: string;
  }
}

const app = new Hono();

const READ_PERMISSION: Record<ShareableObjectType, string> = {
  cost_report: "costs:read",
  cost_report_folder: "costs:read",
  cost_canvas: "costs:read",
  dashboard: "dashboards:read",
};
const WRITE_PERMISSION: Record<ShareableObjectType, string> = {
  cost_report: "costs:write",
  cost_report_folder: "costs:write",
  cost_canvas: "costs:write",
  dashboard: "dashboards:write",
};

function parseType(raw: string): ShareableObjectType | null {
  return SHAREABLE_OBJECT_TYPES.includes(raw as ShareableObjectType)
    ? (raw as ShareableObjectType)
    : null;
}

function parseInput(raw: unknown): ObjectSharingInput {
  if (!raw || typeof raw !== "object") throw new SharingInputError("Expected a JSON object.");
  const body = raw as Record<string, unknown>;
  const orgAccess = body["orgAccess"];
  if (!ORG_ACCESS_LEVELS.includes(orgAccess as (typeof ORG_ACCESS_LEVELS)[number])) {
    throw new SharingInputError("orgAccess must be editor, viewer or none.");
  }
  const grants = body["grants"] ?? [];
  if (!Array.isArray(grants)) throw new SharingInputError("grants must be a list.");
  return {
    orgAccess: orgAccess as ObjectSharingInput["orgAccess"],
    grants: grants.map((g) => {
      const grant = (g ?? {}) as Record<string, unknown>;
      const kind = grant["principalKind"];
      const id = grant["principalId"];
      const level = grant["level"];
      if (!SHARING_GRANT_PRINCIPAL_KINDS.includes(kind as "member" | "role")) {
        throw new SharingInputError("Each grant's principalKind must be member or role.");
      }
      if (typeof id !== "string" || id.length === 0) {
        throw new SharingInputError("Each grant needs a principalId.");
      }
      if (!OBJECT_ACCESS_LEVELS.includes(level as (typeof OBJECT_ACCESS_LEVELS)[number])) {
        throw new SharingInputError("Each grant's level must be owner, editor or viewer.");
      }
      return {
        principalKind: kind as "member" | "role",
        principalId: id,
        level: level as (typeof OBJECT_ACCESS_LEVELS)[number],
      };
    }),
  };
}

app.get("/:objectType/:objectId", async (c) => {
  const type = parseType(c.req.param("objectType"));
  if (!type) return c.json({ error: "Unknown object type" }, 400);
  requirePermission(c, READ_PERMISSION[type]);
  return c.json(await getObjectSharing(c.get("organizationId"), type, c.req.param("objectId")));
});

app.put("/:objectType/:objectId", async (c) => {
  const type = parseType(c.req.param("objectType"));
  if (!type) return c.json({ error: "Unknown object type" }, 400);
  requirePermission(c, WRITE_PERMISSION[type]);
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const objectId = c.req.param("objectId");
  const input = parseInput(await c.req.json().catch(() => null));
  const result = await putObjectSharing(organizationId, type, objectId, input, session.userId);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "sharing.update",
    entityType: type,
    entityId: objectId,
    metadata: { orgAccess: input.orgAccess, grants: input.grants.length },
  });
  return c.json(result);
});

app.delete("/:objectType/:objectId", async (c) => {
  const type = parseType(c.req.param("objectType"));
  if (!type) return c.json({ error: "Unknown object type" }, 400);
  requirePermission(c, WRITE_PERMISSION[type]);
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const objectId = c.req.param("objectId");
  await resetObjectSharing(organizationId, type, objectId);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "sharing.reset",
    entityType: type,
    entityId: objectId,
    metadata: {},
  });
  return c.json({ ok: true });
});

export { app as sharingRoutes };
