import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  email: "dev@example.com",
  token: "ATATT-test-token",
  workspace: "acme",
});
