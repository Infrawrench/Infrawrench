import { Hono, type Context } from "hono";
import { INSTANCE_PRICING_KEY } from "@infrawrench/client-core";
import { authenticateApiRequest } from "@/auth/api-auth";
import {
  InstancePricingNotConfiguredError,
  classifyInstancePricingError,
  getInstancePricingSchema,
  instancePricingWarehouse,
  parseInstancePricingQuery,
  runInstancePricingQuery,
} from "@/services/instance-pricing";

const app = new Hono();

/**
 * `/api/v1/instance-pricing`: read-only SQL over the instance pricing
 * warehouse, the ClickHouse database behind instances.infrawrench.com's chat
 * (tables in `server-core/src/aws-pricing-warehouse/schema.ts`, loaded by the
 * bulk pricing sync): every AWS platform, RunPod, Alibaba Cloud ECS, Azure
 * virtual machines and Google Cloud Compute Engine. Also
 * mounted at `/api/v1/aws-pricing`, its path before it covered other clouds.
 *
 * - `GET /schema`: every table and column with what it holds, the notes a
 *   correct query depends on, and how fresh each source is.
 * - `POST /query` `{ sql, maxRows? }`: one read-only statement's result.
 *
 * Any credential `authenticateApiRequest` accepts may call it, with no scope,
 * like `/api/v1/whoami` and `/api/v1/aws-bulk-pricing`: it is the providers'
 * public price lists. The warehouse token is read-only, which is the real boundary.
 *
 * `POST /api/v1/instance-pricing/query`, and no other route (not even its
 * `aws-pricing` alias), also accepts the key the web and desktop apps ship with
 * (`client-core/src/instance-pricing-key.ts`), so the resource page's pricing
 * panel works with no account: the desktop app runs signed out, and the web
 * SPA's session is a cookie this router does not read.
 *
 * The MCP and chat tools (`tools/instance-pricing.ts`) call the same helpers.
 */

function unavailable(c: Context) {
  return c.json(
    { error: "The instance pricing warehouse is not configured on this deployment" },
    503,
  );
}

function carriesQueryKey(c: Context): boolean {
  return (
    c.req.method === "POST" &&
    c.req.path === "/api/v1/instance-pricing/query" &&
    c.req.header("authorization") === `Bearer ${INSTANCE_PRICING_KEY}`
  );
}

app.use("*", async (c, next) => {
  if (carriesQueryKey(c)) return next();
  const auth = await authenticateApiRequest(c.req.raw);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

app.get("/schema", async (c) => {
  return c.json(await getInstancePricingSchema(), 200, {
    "cache-control": "private, max-age=300",
  });
});

app.post("/query", async (c) => {
  if (!instancePricingWarehouse()) return unavailable(c);
  const body = (await c.req.json().catch(() => null)) as {
    sql?: unknown;
    maxRows?: unknown;
  } | null;
  const parsed = parseInstancePricingQuery(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    return c.json(await runInstancePricingQuery(parsed.sql, parsed.maxRows), 200, {
      "cache-control": "private, no-store",
    });
  } catch (error) {
    if (error instanceof InstancePricingNotConfiguredError) return unavailable(c);
    const failure = classifyInstancePricingError(error);
    return c.json({ error: failure.error }, failure.status);
  }
});

export { app as instancePricingRoutes };
