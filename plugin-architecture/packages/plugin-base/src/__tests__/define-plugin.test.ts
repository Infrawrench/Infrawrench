import { describe, expect, expectTypeOf, it } from "vitest";
import {
  clientContractProblems,
  defineCredentials,
  definePlugin,
  validatePluginContract,
} from "../define-plugin.js";
import type { ClientFor, CredentialsOf } from "../define-plugin.js";
import type { PluginClient, PluginManifest } from "../manifest.js";

const baseManifest = {
  id: "demo",
  displayName: "Demo",
  logoSvg: "<svg/>",
  egressHosts: ["api.example.test"],
  credentialFields: defineCredentials([
    { key: "apiToken", label: "Token", sensitive: true },
    { key: "region", label: "Region", sensitive: false, optional: true },
  ]),
} satisfies PluginManifest;

const stubClient = {
  listResources: () => {
    throw new Error("unused");
  },
} as unknown as PluginClient;

describe("CredentialsOf", () => {
  it("names the declared keys and nothing else", () => {
    type C = CredentialsOf<typeof baseManifest>;
    expectTypeOf<C>().toHaveProperty("apiToken");
    expectTypeOf<C>().toHaveProperty("region");
    // @ts-expect-error a key the manifest never declared
    const typo = (c: C) => c.apiTokn;
    expect(typo).toBeTypeOf("function");
  });

  it("always allows the host-owned OAuth grant state", () => {
    expectTypeOf<CredentialsOf<typeof baseManifest>>().toHaveProperty("__oauth");
  });

  it("lets a plugin name keys that have no form field", () => {
    expectTypeOf<CredentialsOf<typeof baseManifest, "minted">>().toHaveProperty("minted");
  });
});

describe("ClientFor", () => {
  it("makes a declared capability's method required", () => {
    const manifest = { ...baseManifest, quotas: {} } satisfies PluginManifest;
    expectTypeOf<ClientFor<typeof manifest>["fetchQuotas"]>().not.toBeNullable();
    expectTypeOf<ClientFor<typeof baseManifest>["fetchQuotas"]>().toBeNullable();
  });

  it("rejects a client missing a declared capability at the definePlugin call", () => {
    const manifest = { ...baseManifest, quotas: {} } satisfies PluginManifest;
    const plugin = definePlugin({
      manifest,
      resourceTypes: [],
      testCredentials: { apiToken: "t" },
      // @ts-expect-error fetchQuotas is required once `quotas` is declared
      createClient: () => stubClient,
    });
    expect(plugin.manifest.id).toBe("demo");
  });

  it("does not trust a flag only known as boolean", () => {
    const flag: boolean = false;
    const manifest = {
      ...baseManifest,
      secretScanning: { scannerType: "x", canResolve: flag },
    };
    expectTypeOf<ClientFor<typeof manifest>["resolveLeakedSecret"]>().toBeNullable();
  });
});

describe("definePlugin", () => {
  it("requires test credentials for non-optional fields", () => {
    const plugin = definePlugin({
      manifest: baseManifest,
      resourceTypes: [],
      // @ts-expect-error apiToken is not optional
      testCredentials: { region: "eu" },
      createClient: () => stubClient,
    });
    expect(plugin.testCredentials).toEqual({ region: "eu" });
  });
});

describe("validatePluginContract", () => {
  const plugin = (manifest: Partial<PluginManifest>, rest: object = {}) => ({
    manifest: { ...baseManifest, ...manifest },
    ...rest,
  });

  it("is quiet for a plugin that declares nothing", () => {
    expect(validatePluginContract(plugin({}))).toEqual([]);
  });

  it("names a hook the manifest obliges and the plugin lacks", () => {
    const problems = validatePluginContract(
      plugin({ statusFeed: { url: "https://x.test" } } as never),
    );
    expect(problems).toEqual([expect.stringContaining("parseStatusFeed")]);
  });

  it("checks the public half of a price catalog only", () => {
    const publicCatalog = { requiresCredentials: false } as never;
    const needsCreds = { requiresCredentials: true } as never;
    expect(validatePluginContract(plugin({ priceCatalog: publicCatalog }))).toEqual([
      expect.stringContaining("fetchPriceCatalog"),
    ]);
    expect(validatePluginContract(plugin({ priceCatalog: needsCreds }))).toEqual([]);
  });
});

describe("clientContractProblems", () => {
  const withTypes = (flags: object) => ({
    manifest: baseManifest,
    resourceTypes: [{ id: "thing", ...flags }] as never,
  });

  it("names a client method a resource type flag obliges", () => {
    expect(clientContractProblems(withTypes({ supportsDelete: true }), {})).toEqual([
      expect.stringContaining("deleteResource"),
    ]);
    expect(
      clientContractProblems(withTypes({ supportsDelete: true }), { deleteResource() {} }),
    ).toEqual([]);
  });

  it("names a client method a manifest declaration obliges", () => {
    const manifest = { ...baseManifest, quotas: {} } as never;
    expect(clientContractProblems({ manifest, resourceTypes: [] }, {})).toEqual([
      expect.stringContaining("fetchQuotas"),
    ]);
  });

  it("requires the managed webhook methods only for managed webhooks", () => {
    const paging = (mode: string) =>
      ({ ...baseManifest, paging: { webhook: { mode } } }) as unknown as PluginManifest;
    const fullPaging = { listPagingTargets() {}, sendPagingEvent() {} };
    expect(
      clientContractProblems({ manifest: paging("manual"), resourceTypes: [] }, fullPaging),
    ).toEqual([]);
    expect(
      clientContractProblems({ manifest: paging("managed"), resourceTypes: [] }, fullPaging),
    ).toEqual([
      expect.stringContaining("registerPagingWebhook"),
      expect.stringContaining("removePagingWebhook"),
    ]);
  });
});
