import type { InstancePricingQuery, InstancePricingResult } from "@infrawrench/client-core";
import { invoke } from "./invoke";

export const desktopInstancePricingQuery: InstancePricingQuery = (sql, maxRows) =>
  invoke<InstancePricingResult>("instance_pricing_query", { sql, maxRows });
