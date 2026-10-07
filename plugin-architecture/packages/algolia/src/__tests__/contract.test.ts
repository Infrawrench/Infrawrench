import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, { appId: "TESTAPP123", apiKey: "test-algolia-admin-key" });
