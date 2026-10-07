import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  authUrl: "https://keystone.example.com:5000/v3",
  applicationCredentialId: "423f19a4ac1e4f48bbb4180756e6eb6c",
  applicationCredentialSecret: "test-secret",
});
