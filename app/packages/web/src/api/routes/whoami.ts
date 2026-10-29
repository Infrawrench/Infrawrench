import { Hono } from "hono";
import { authenticateApiRequest } from "@/auth/api-auth";

const app = new Hono();

/**
 * GET /api/v1/whoami: who a bearer credential belongs to.
 *
 * Accepts every credential `authenticateApiRequest` does (`iwk_` API keys,
 * `iwa_` agent credentials, WorkOS access tokens for a person or an agent) and
 * needs no scope, because it reveals nothing the holder could not already
 * learn by using the credential. Its job is to answer "is this credential live,
 * and whose is it?" for callers that sit outside this API, such as the
 * `@infrawrench/instances-bundles` Worker, without making them pick an
 * org-scoped route that a key may lack the scope for.
 */
app.get("/", async (c) => {
  const auth = await authenticateApiRequest(c.req.raw);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  const principal = auth.agentRegistrationId ? "agent" : auth.apiKeyId ? "api_key" : "user";
  return c.json({
    userId: auth.userId,
    organizationId: auth.organizationId,
    principal,
  });
});

export { app as whoamiRoutes };
