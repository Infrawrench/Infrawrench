import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  environmentUrl: "https://abc12345.live.dynatrace.com",
  apiToken: "dt0c01.TEST.SECRET",
});
