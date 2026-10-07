import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  url: "http://prometheus.internal:9090",
  alertmanagerUrl: "http://alertmanager.internal:9093",
});
