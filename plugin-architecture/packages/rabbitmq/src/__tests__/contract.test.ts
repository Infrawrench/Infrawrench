import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  url: "https://mq.example.com:15671",
  username: "infrawrench",
  password: "secret",
});
