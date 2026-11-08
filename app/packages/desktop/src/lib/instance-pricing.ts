import type { InstancePricingQuery } from "@infrawrench/client-core";
import { DesktopRpcClient, runRpc } from "./rpc/client";

export const desktopInstancePricingQuery: InstancePricingQuery = (sql, maxRows) =>
  runRpc(DesktopRpcClient.use((rpc) => rpc.InstancePricingQuery({ sql, maxRows })));
