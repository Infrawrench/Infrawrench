import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  apiKey: "cu_test",
  accountId: "00000000-0000-0000-0000-000000000000",
});
