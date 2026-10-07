import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";

const creds = {
  url: "https://pve.example.com:8006",
  tokenId: "infrawrench@pve!infrawrench",
  tokenSecret: "00000000-0000-0000-0000-000000000000",
};

runPluginContractTests(plugin, creds);
