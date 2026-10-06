import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, { url: "https://gitlab.com", token: "glpat-test-token", group: "" });
