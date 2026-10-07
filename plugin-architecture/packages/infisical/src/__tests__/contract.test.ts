import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  siteUrl: "https://app.infisical.com",
  clientId: "00000000-0000-0000-0000-000000000000",
  clientSecret: "test-secret",
});
