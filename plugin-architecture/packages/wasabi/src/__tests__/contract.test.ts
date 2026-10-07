import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  accessKey: "TESTACCESSKEY0000000",
  secretKey: "test-wasabi-secret",
});
