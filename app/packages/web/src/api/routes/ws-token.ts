import { Hono } from "hono";
import { createWsToken } from "../../services/ws-tokens";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** POST /api/ws-token */
app.post("/", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const { userId } = c.get("session");
  const token = await createWsToken(userId, organizationId);
  return c.json({ token });
});

export { app as wsTokenRoutes };
