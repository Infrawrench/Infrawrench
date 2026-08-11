import { Hono, type Context } from "hono";

import { getNetworkFlowFeed } from "@infrawrench/server-core/network-flow/feed";
import {
  getNetworkFlowSettings,
  setNetworkFlowSettings,
  NetworkFlowSettingsError,
} from "@infrawrench/server-core/network-flow/settings";
import { logAudit } from "../../services/audit";
import { NETWORK_FLOW_SCOPES } from "@infrawrench/plugin-base";

import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Default window: the last 14 days.
 *
 * Shorter than the cost surface's 30 because flow retention is shorter — AWS
 * CloudWatch log groups commonly keep 7 or 30 days and the plugin will not ask
 * beyond 14 — so a 30-day default would open on a chart that is empty for the
 * first half and look broken.
 */
function parseRange(c: Context): { from: string; to: string } | null {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
  const from = c.req.query("from") ?? defaultFrom;
  const to = c.req.query("to") ?? today;
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  return { from, to };
}

/**
 * GET / — the whole network-costs screen: boundary summary, top pairs,
 * per-account collection state and the rate cards the money came from.
 *
 * `costs:read`, not a permission of its own. This is spend information — the
 * same class of fact as "what did EC2 cost" — and splitting it behind a second
 * read permission would mean an org could grant someone the bill without the
 * explanation of it, which is the pairing nobody wants.
 */
app.get("/", async (c: Context) => {
  requirePermission(c, "costs:read");
  const range = parseRange(c);
  if (!range) return c.json({ error: "from/to must be YYYY-MM-DD with from <= to" }, 400);

  const scope = c.req.query("scope");
  if (scope !== undefined && !NETWORK_FLOW_SCOPES.includes(scope as never)) {
    return c.json({ error: `scope must be one of ${NETWORK_FLOW_SCOPES.join(", ")}` }, 400);
  }

  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return c.json({ error: "limit must be an integer between 1 and 200" }, 400);
  }

  return c.json(
    await getNetworkFlowFeed(c.get("organizationId") as string, {
      from: range.from,
      to: range.to,
      limit,
      ...(scope ? { scope } : {}),
      ...(c.req.query("accountId") ? { accountId: c.req.query("accountId") } : {}),
    }),
  );
});

/** GET /settings — the org's collection switch, without the data. */
app.get("/settings", async (c: Context) => {
  requirePermission(c, "costs:read");
  return c.json(await getNetworkFlowSettings(c.get("organizationId") as string));
});

/**
 * PUT /settings — turn collection on or off.
 *
 * `org:settings:write`, deliberately not `costs:write`. Turning this on does
 * not edit a cost object; it authorizes Infrawrench to run queries that the
 * *provider bills to the organization's own cloud account* every day, in
 * perpetuity, until somebody turns it off. That is a governance decision of the
 * same kind as a billing rule or an exchange rate, and it is audit-logged for
 * the same reason: when the line shows up on a bill review, somebody needs to
 * be able to find out who agreed to it.
 */
app.put("/settings", async (c: Context) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId") as string;
  const session = c.get("session");

  const body = (await c.req.json()) as Record<string, unknown>;
  if (typeof body["enabled"] !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  const lookback = body["initialLookbackDays"];
  if (lookback !== undefined && typeof lookback !== "number") {
    return c.json({ error: "initialLookbackDays must be a number" }, 400);
  }

  try {
    const current = await getNetworkFlowSettings(organizationId);
    const settings = await setNetworkFlowSettings(
      organizationId,
      {
        enabled: body["enabled"],
        initialLookbackDays: (lookback as number | undefined) ?? current.initialLookbackDays,
      },
      session.userId,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: settings.enabled ? "network_flows.enable" : "network_flows.disable",
      entityType: "organization",
      entityId: organizationId,
      metadata: { initialLookbackDays: settings.initialLookbackDays },
    });
    return c.json(settings);
  } catch (e) {
    if (e instanceof NetworkFlowSettingsError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

export { app as networkFlowRoutes };
