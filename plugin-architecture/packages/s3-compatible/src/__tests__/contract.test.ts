import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  endpoint: "https://minio.example.com:9000",
  accessKey: "minioadmin",
  secretKey: "minioadmin-secret",
});
