import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

runPluginContractTests(plugin, {
  url: "https://vcenter.example.com",
  username: "svc-infrawrench@vsphere.local",
  password: "test-password",
});
