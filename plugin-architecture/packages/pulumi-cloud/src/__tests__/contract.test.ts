import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, { accessToken: "pul-test", organization: "acme", plan: "pro" });
