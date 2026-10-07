import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  baseUrl: "https://acme.jfrog.io",
  accessToken: "test-jfrog-token",
});
