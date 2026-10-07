import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  endpoint: "https://test.c0.europe-west3.gcp.weaviate.cloud",
  apiKey: "test-weaviate-key",
});
