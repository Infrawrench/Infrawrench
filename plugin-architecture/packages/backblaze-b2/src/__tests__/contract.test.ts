import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  applicationKeyId: "005testkeyid0000000000001",
  applicationKey: "K005testapplicationkey",
});
