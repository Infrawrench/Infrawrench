import { Hono } from "hono";
import type { AuthSession } from "@/api/auth-middleware";

type AnyHono = Parameters<Hono["route"]>[1];

/**
 * Build a test Hono app pre-populated with a fake auth session and
 * organization context, then mount the given route group at "/".
 *
 * All `__tests__/*.test.ts` files in this directory historically duplicated
 * this same scaffolding — this helper centralises it.
 */
export function buildTestApp(routes: AnyHono): Hono {
  const app = new Hono();
  const session: AuthSession = {
    userId: "user-1",
    email: "test@example.com",
  };
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    return next();
  });
  app.route("/", routes);
  return app;
}
