import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  accessKeyId: "LTAI5ttest",
  accessKeySecret: "test-secret",
  region: "ap-southeast-1",
});
