import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  region: "us1",
  managementKeyId: "hcxmk_test",
  managementKeySecret: "test-secret",
  configurationKey: "test-config-key",
});
