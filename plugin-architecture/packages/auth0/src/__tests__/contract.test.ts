import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  domain: "acme.us.auth0.com",
  clientId: "test-auth0-client",
  clientSecret: "test-auth0-secret",
});
