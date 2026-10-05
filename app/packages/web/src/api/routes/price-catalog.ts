import { Hono } from "hono";
import {
  getPriceCatalogService,
  PriceCatalogNotFoundError,
  PriceCatalogQueryError,
} from "@infrawrench/server-core/price-catalog";
import {
  normalizePriceCatalogCompareQuery,
  normalizePriceCatalogSearchQuery,
} from "@infrawrench/client-core";
import { requirePermission } from "../../auth/permissions";

const app = new Hono();

/**
 * The org-level price catalog: every catalog provider's published list
 * prices, searchable and comparable across providers.
 *
 * `resources:read`, like right-sizing: nothing here is the org's billing
 * data, but a credentialed provider's catalog is fetched with one of the
 * org's accounts, so the routes stay authenticated and org-scoped.
 */
app.get("/providers", async (c) => {
  requirePermission(c, "resources:read");
  const providers = await getPriceCatalogService().listProviders(c.get("organizationId"));
  return c.json({ providers });
});

app.get("/search", async (c) => {
  requirePermission(c, "resources:read");
  const query = normalizePriceCatalogSearchQuery(c.req.query());
  return c.json(await getPriceCatalogService().search(c.get("organizationId"), query));
});

app.get("/compare", async (c) => {
  requirePermission(c, "resources:read");
  const query = normalizePriceCatalogCompareQuery(c.req.query());
  try {
    return c.json(await getPriceCatalogService().compare(c.get("organizationId"), query));
  } catch (e) {
    if (e instanceof PriceCatalogQueryError) return c.json({ error: e.message }, 400);
    if (e instanceof PriceCatalogNotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});

export { app as priceCatalogRoutes };
