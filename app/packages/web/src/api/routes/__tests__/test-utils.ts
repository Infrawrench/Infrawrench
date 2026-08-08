import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";

type AnyHono = Parameters<Hono["route"]>[1];

/**
 * Build a test Hono app pre-populated with a fake auth session, organization
 * context, and full permissions, then mount the given route group at "/".
 *
 * All `__tests__/*.test.ts` files in this directory historically duplicated
 * this same scaffolding — this helper centralises it.
 *
 * Pass `permissions` to exercise a gate: a route group's own test is the only
 * place a 403 boundary can be proved, since the default caller holds `*`.
 */
export function buildTestApp(routes: AnyHono, permissions: string[] = ["*"]): Hono {
  const app = new Hono();
  const session: AuthSession = {
    userId: "user-1",
    email: "test@example.com",
  };
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    // Tests run as if the user has every permission unless one is asked for;
    // per-permission gating is covered by dedicated route tests when needed.
    c.set("permissions", permissions);
    c.set("role", null);
    return next();
  });
  app.route("/", routes);
  return app;
}
