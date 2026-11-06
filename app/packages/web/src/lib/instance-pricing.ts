import { queryInstancePricing, type InstancePricingQuery } from "@infrawrench/client-core";

export const webInstancePricingQuery: InstancePricingQuery = (sql, maxRows) =>
  queryInstancePricing("", sql, maxRows);
