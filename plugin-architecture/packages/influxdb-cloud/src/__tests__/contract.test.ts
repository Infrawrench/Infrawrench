import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  region: "us-east-1-1",
  token: "test-influx-token",
  orgId: "org1",
});
