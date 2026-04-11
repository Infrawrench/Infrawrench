import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { workos, clientId } from "../../auth/workos";

const app = new Hono();

/** GET /callback — WorkOS OAuth callback */
app.get("/", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing code parameter", 400);
  }

  const cookiePassword = process.env["WORKOS_COOKIE_PASSWORD"];
  if (!cookiePassword) {
    throw new Error("WORKOS_COOKIE_PASSWORD is required");
  }

  const { sealedSession } = await workos.userManagement.authenticateWithCode({
    code,
    clientId,
    session: { sealSession: true, cookiePassword },
  });

  if (!sealedSession) {
    return c.text("Failed to seal session", 500);
  }

  setCookie(c, "wos-session", sealedSession, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 400, // ~13 months
  });

  return c.redirect("/");
});

export { app as callbackRoutes };
