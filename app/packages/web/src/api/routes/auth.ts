import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { workos, clientId } from "../../auth/workos";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/auth/sign-in — redirect to WorkOS login */
app.get("/sign-in", async (c) => {
  const redirectUri =
    process.env["WORKOS_REDIRECT_URI"] ??
    "http://localhost:3000/callback";

  const url = workos.userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId,
    redirectUri,
  });
  return c.redirect(url);
});

/** GET /api/auth/me — return current session (used by SPA on load) */
app.get("/me", async (c) => {
  const session = c.get("session");
  return c.json(session);
});

/** POST /api/auth/sign-out — clear the session cookie */
app.post("/sign-out", async (c) => {
  deleteCookie(c, "wos-session", { path: "/" });
  return c.json({ ok: true });
});

export { app as authRoutes };
