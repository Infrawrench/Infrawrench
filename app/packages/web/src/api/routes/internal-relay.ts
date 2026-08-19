/**
 * The receiving end of the cross-replica relay.
 *
 * A session that lives in one pod's memory — today a Linux application
 * session, tomorrow the shared-console pty and the bastion registry that
 * `infra/k8s/web-ws-ingress.yaml` says are waiting on the same mechanism — can
 * only be driven by the pod holding it. `services/replica-relay.ts` leases the
 * session to that pod and forwards calls here; this route runs them.
 *
 * ## What authenticates this
 *
 * `INTERNAL_RELAY_SECRET`, compared in constant time, and nothing else. This is
 * a pod-to-pod endpoint: the caller is another replica of this same
 * deployment, and what it forwards is an operation it has *already*
 * authorised — `tools/linux-apps.ts` checked `resources:execute` before any of
 * this happened. So the secret is not standing in for a user's permissions; it
 * is what makes "this came from one of our pods" a fact rather than a hope.
 *
 * Two things keep that honest. The organization is part of the session key and
 * is re-applied to the resource lookup on this side (`resolveTarget` filters on
 * `organizationId`), so a forwarded call cannot reach across orgs however it is
 * shaped. And the relay only ever dials private pod addresses out of its own
 * table, so this endpoint is not a hop anyone outside the cluster can aim.
 *
 * It is mounted outside every session-auth layer for the same reason the agent
 * ceremony is: its whole purpose is serving a caller that has no session.
 */
import { Hono } from "hono";
import { z } from "zod";

import {
  runLocally,
  encodeOpResult,
  AppsHostError,
  type AppsOp,
} from "../../services/apps-headless";
import { verifyRelaySecret } from "../../services/replica-relay";

const relayRoutes = new Hono();

const APPS_OPS = [
  "listApps",
  "launch",
  "windows",
  "screenshot",
  "a11yTree",
  "click",
  "typeText",
  "pressKeys",
  "scroll",
  "closeWindow",
  "end",
] as const satisfies readonly AppsOp[];

const callSchema = z.object({
  kind: z.literal("linux-app"),
  key: z.string().min(1),
  op: z.enum(APPS_OPS),
  payload: z
    .object({
      organizationId: z.string().min(1),
      resourceId: z.string().min(1),
      userId: z.string().optional(),
      sshKeyId: z.string().optional(),
      username: z.string().optional(),
    })
    .passthrough(),
});

relayRoutes.post("/relay", async (c) => {
  if (!verifyRelaySecret(c.req.header("authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const parsed = callSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Malformed relay call" }, 400);
  const { key, op, payload } = parsed.data;

  // The key is derived from the org and resource on the sending side; if the
  // two disagree, the lease this call was routed on is not the session it is
  // asking for, and running it would drive the wrong host.
  if (key !== `${payload.organizationId}:${payload.resourceId}`) {
    return c.json({ error: "Relay key does not match its payload" }, 400);
  }

  const ref = {
    organizationId: payload.organizationId,
    resourceId: payload.resourceId,
    ...(payload.userId ? { userId: payload.userId } : {}),
    ...(payload.sshKeyId ? { sshKeyId: payload.sshKeyId } : {}),
    ...(payload.username ? { username: payload.username } : {}),
  };

  try {
    return c.json(encodeOpResult(op, await runLocally(ref, op, payload)));
  } catch (error) {
    // A host-level failure is the answer, not a server fault: the forwarding
    // pod re-raises it to whoever asked, so it must arrive with its message
    // intact rather than as a 500 the caller cannot explain.
    if (error instanceof AppsHostError) return c.json({ error: error.message }, 422);
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[relay] ${op} failed for ${key}:`, message);
    return c.json({ error: message }, 422);
  }
});

export default relayRoutes;
