import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, { apiKey: "test-api-key", region: "us-south" });
