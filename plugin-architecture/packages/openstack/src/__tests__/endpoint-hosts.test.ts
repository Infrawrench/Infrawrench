import { hostPlugin } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { OpenStackApi } from "../api.js";
import { manifest, plugin } from "../plugin.js";
import { APP, transport } from "./harness.js";

describe("service endpoint hosts", () => {
  it("is a host field the bastion allowlist reads", () => {
    const field = manifest.credentialFields.find((f) => f.key === "endpointHosts");
    expect(field).toMatchObject({ providerHost: true, sensitive: false, optional: true });
    expect(field?.providerOptions).toMatchObject({ dependsOn: ["authUrl"], multiple: true });
  });

  it("offers the catalog hosts the account will call, without the Keystone one", async () => {
    const { http } = transport(() => undefined);
    const options = await hostPlugin(plugin).listCredentialOptions!(
      "endpointHosts",
      { ...APP },
      { http },
    );
    expect(options.map((o) => o.id)).toEqual([
      "cinder.example.com",
      "neutron.example.com",
      "nova.example.com",
      "swift.example.com",
    ]);
    expect(options.find((o) => o.id === "nova.example.com")?.description).toBe("compute");
  });

  it("follows the region and interface on the account", async () => {
    const { http } = transport(() => undefined);
    const options = await hostPlugin(plugin).listCredentialOptions!(
      "endpointHosts",
      { ...APP, region: "RegionTwo" },
      { http },
    );
    expect(options.map((o) => o.id)).toEqual(["nova2.example.com"]);
    const internal = await hostPlugin(plugin).listCredentialOptions!(
      "endpointHosts",
      { ...APP, interface: "internal" },
      { http },
    );
    expect(internal.map((o) => o.id)).toContain("neutron.internal");
  });

  it("names the field when a bastion refuses a catalog host", async () => {
    const http: HttpHostServices = {
      async request(req) {
        throw new Error("fetch failed", {
          cause: new Error(
            `${new URL(req.url).hostname} is not allowed for this account: it is neither one of the plugin's hosts nor the account's own`,
          ),
        });
      },
    };
    const api = new OpenStackApi(APP, http);
    await expect(api.raw("GET", "https://nova.example.com/v2.1/servers", {})).rejects.toThrow(
      "Service Endpoint Hosts",
    );
  });
});
