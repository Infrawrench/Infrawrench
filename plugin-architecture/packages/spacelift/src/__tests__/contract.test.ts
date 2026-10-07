import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, { endpoint: "acme", apiKeyId: "01HTEST", apiKeySecret: "secret" });
