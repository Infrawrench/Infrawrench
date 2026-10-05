import { ipcMain } from "electron";
import type {
  PriceCatalogCompareQuery,
  PriceCatalogSearchQuery,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { cloudFetch } from "./shared";

// Price catalog: cloud mode only. The catalog is assembled server-side (it
// borrows one of the org's accounts for providers whose price API needs
// credentials, and caches each provider's list on its declared cadence), the
// same `/price-catalog/*` routes the web tab uses. The query is serialized
// here rather than accepted as a path so the renderer can only ever reach
// these two routes.
//
// The client-core import is dynamic because this module graph is CommonJS and
// client-core ships ESM (see `local-posture.ts`); electron-vite bundles it.

async function queryString(query: PriceCatalogSearchQuery | PriceCatalogCompareQuery) {
  const { priceCatalogQueryString } = await import("@infrawrench/client-core");
  return priceCatalogQueryString(query ?? {});
}

ipcMain.handle(
  "cloud_price_catalog_search",
  async (_e, { orgId, query }: { orgId: string; query: PriceCatalogSearchQuery }) =>
    cloudFetch(orgId, `/price-catalog/search${await queryString(query)}`),
);

ipcMain.handle(
  "cloud_price_catalog_compare",
  async (_e, { orgId, query }: { orgId: string; query: PriceCatalogCompareQuery }) =>
    cloudFetch(orgId, `/price-catalog/compare${await queryString(query)}`),
);
