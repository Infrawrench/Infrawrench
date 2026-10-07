import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, { orgUrl: "https://acme.okta.com", apiToken: "00test-okta-token" });
