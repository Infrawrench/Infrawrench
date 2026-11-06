import type { InstancePricingHostServices } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};
import { CLOUD_URL } from "../env";

/**
 * The main process's way to the instance pricing warehouse: the apps' built-in
 * key against the cloud API, so it works signed out. No GUI side effects, since
 * the CLI's plugin runtime uses it too.
 */
export const mainInstancePricing: InstancePricingHostServices = {
  async query(sql, maxRows) {
    const { queryInstancePricing } = await import("@infrawrench/client-core");
    return queryInstancePricing(CLOUD_URL, sql, maxRows);
  },
};
