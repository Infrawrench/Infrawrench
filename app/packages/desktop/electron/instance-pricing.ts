import { ipcMain } from "electron";
import { mainInstancePricing } from "./instance-pricing-client";

/**
 * The renderer's way to the instance pricing warehouse. In the main process
 * because, unlike the other cloud calls, it needs no signed-in account (a
 * local-only install has it too), and the renderer's CSP stays closed to the
 * cloud host.
 */
ipcMain.handle(
  "instance_pricing_query",
  async (_event, { sql, maxRows }: { sql: unknown; maxRows: unknown }) => {
    if (typeof sql !== "string" || typeof maxRows !== "number") {
      throw new Error("instance_pricing_query needs `sql` and `maxRows`");
    }
    return mainInstancePricing.query(sql, maxRows);
  },
);
