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
  // A key or agent mints a token that carries its own ceiling. Without it the
  // socket would resolve permissions from `userId` alone, which for a key is
  // its owner's whole role: see `services/ws-auth.ts`.
  const apiKey = c.get("apiKey");
  const token = await createWsToken(
    userId,
    organizationId,
    apiKey
      ? {
          scopes: apiKey.scopes,
          ...(apiKey.agentRegistrationId
            ? { agentRegistrationId: apiKey.agentRegistrationId }
            : {}),
        }
      : undefined,
  );
  return c.json({ token });
});

export { app as wsTokenRoutes };
