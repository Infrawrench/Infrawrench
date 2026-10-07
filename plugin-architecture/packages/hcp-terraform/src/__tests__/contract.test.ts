import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  apiToken: "test.atlasv1.token",
  hostname: "app.terraform.io",
  organization: "acme",
});
