import { ipcMain } from "electron";
import { CLOUD_URL } from "../env";

/**
 * The instance pricing panel's queries. In the main process, unlike the other
 * cloud call it needs no signed-in account (a local-only install has the panel
 * too), and the renderer's CSP stays closed to the cloud host.
 */
ipcMain.handle(
  "instance_pricing_query",
  async (_event, { sql, maxRows }: { sql: unknown; maxRows: unknown }) => {
    if (typeof sql !== "string" || typeof maxRows !== "number") {
      throw new Error("instance_pricing_query needs `sql` and `maxRows`");
    }
    const { queryInstancePricing } = await import("@infrawrench/client-core");
    return queryInstancePricing(CLOUD_URL, sql, maxRows);
  },
);
