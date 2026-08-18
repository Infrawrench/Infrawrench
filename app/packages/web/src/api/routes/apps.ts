/**
 * Whether a host can run Linux applications, and installing what it cannot.
 *
 * The session itself is a WebSocket (`/api/apps`, handled in `server.ts`)
 * because it carries a binary protocol. These two are plain requests, and they
 * have to be: the check exists to answer on a host where opening a session
 * would fail — the missing piece may be the `gunzip` that unpacks the app
 * server — so it cannot live inside the session it is there to protect.
 *
 * `POST /setup` is the only route in the app-streaming surface that changes the
 * customer's machine. It takes requirement ids, never a command; it needs
 * `resources:execute`; it respects change freezes, because installing packages
 * on a production host is a change; and it is audited either way.
 */
import { Hono } from "hono";
import { z } from "zod";
import { PassThrough, Readable } from "node:stream";

import { requirePermission } from "../../auth/permissions";
import { checkChangeFreeze } from "../../services/change-freezes";
import { HostKeyTrustRequiredError } from "../../services/ssh-host-keys";
import { hostKeyTrustResponse } from "./ssh-host-keys";
import { AppsKeyMissingError } from "../../services/apps-host";
import { checkAppsHost, installAppsHostRequirements } from "../../services/apps-preflight";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * The destination, named exactly as the WebSocket names it: an account, a
 * resource, the org's key, and the address the resource reported. The host goes
 * through `resolveSafeHost` before anything is dialled, in `apps-host.ts`.
 */
const targetSchema = z
  .object({
    accountId: z.string().min(1),
    resourceId: z.string().min(1),
    sshKeyId: z.string().min(1),
    host: z.string().min(1),
    username: z.string().min(1).max(64),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

const REQUIREMENT_IDS = ["gzip", "xkb", "dbus", "fonts", "mesa", "icons"] as const;

const setupSchema = targetSchema
  .extend({
    /**
     * Which requirements to satisfy. Omitted means every missing required one —
     * the "install everything needed" case, which is what the button does.
     */
    requirements: z.array(z.enum(REQUIREMENT_IDS)).min(1).max(REQUIREMENT_IDS.length).optional(),
  })
  .strict();

/** Map the SSH-shaped failures every route here shares onto responses. */
function sshFailure(c: Parameters<typeof hostKeyTrustResponse>[0], error: unknown) {
  if (error instanceof HostKeyTrustRequiredError) return hostKeyTrustResponse(c, error);
  if (error instanceof AppsKeyMissingError) return c.json({ error: "SSH key not found" }, 404);
  return null;
}

/**
 * POST /api/org/:orgId/apps/check
 *
 * A POST rather than a GET because it opens an SSH connection to somewhere the
 * caller named, which is not something to leave sitting in a URL — and because
 * it must not be cached: the whole value is that it says what the host is
 * *now*, after an install.
 */
app.post("/check", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const parsed = targetSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
  }
  const input = parsed.data;

  try {
    const result = await checkAppsHost({
      organizationId,
      sshKeyId: input.sshKeyId,
      host: input.host,
      username: input.username,
      ...(input.port !== undefined ? { port: input.port } : {}),
    });
    return c.json(result);
  } catch (error) {
    const handled = sshFailure(c, error);
    if (handled) return handled;
    return c.json({ error: error instanceof Error ? error.message : "Check failed" }, 502);
  }
});

/**
 * POST /api/org/:orgId/apps/setup
 *
 * Streams NDJSON: one `{"line":"…"}` per line of package-manager output, then a
 * final `{"outcome":{…}}`. Streamed rather than answered at the end because an
 * `apt-get install` is tens of seconds of silence otherwise, and silence in
 * front of something installing packages on your server reads as a hang.
 */
app.post("/setup", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = setupSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
  }
  const input = parsed.data;

  // Installing packages on a host is a change to production, and the org may
  // have declared that changes are not happening right now.
  const frozen = await checkChangeFreeze(c, {
    action: "linux_app.host_setup",
    entityType: "resource",
    entityId: input.resourceId,
    metadata: { accountId: input.accountId, host: input.host },
  });
  if (frozen) return frozen;

  const stream = new PassThrough();
  const write = (payload: unknown) => {
    if (!stream.writableEnded) stream.write(`${JSON.stringify(payload)}\n`);
  };

  // Started before the response is returned, and deliberately not awaited: the
  // body is the progress. A failure has to reach the client *in* the stream —
  // the status line has already gone by the time anything can go wrong.
  void (async () => {
    try {
      const outcome = await installAppsHostRequirements({
        organizationId,
        ...(session.userId ? { userId: session.userId } : {}),
        accountId: input.accountId,
        resourceId: input.resourceId,
        sshKeyId: input.sshKeyId,
        host: input.host,
        username: input.username,
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.requirements ? { include: input.requirements } : {}),
        onOutput: (line) => write({ line }),
      });
      write({ outcome });
    } catch (error) {
      // A host key that changed between the check and the install cannot use the
      // 409 the other route sends — the status line went out before the first
      // package was touched — so the same fields travel inside the stream, and
      // the client can still prompt with a fingerprint rather than a bare code.
      if (error instanceof HostKeyTrustRequiredError) {
        write({
          error: "ssh_host_key_trust_required",
          message: error.message,
          kind: error.kind,
          host: error.host,
          port: error.port,
          presentedFingerprint: error.presentedFingerprint,
          storedFingerprint: error.storedFingerprint,
        });
      } else {
        write({
          error:
            error instanceof AppsKeyMissingError
              ? "SSH key not found"
              : error instanceof Error
                ? error.message
                : "Install failed",
        });
      }
    } finally {
      stream.end();
    }
  })();

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      // Progress that a proxy holds until the end is not progress.
      "X-Accel-Buffering": "no",
    },
  });
});

export { app as appsRoutes };
