import { describe, expect, expectTypeOf, it } from "vitest";
import { ciAlias } from "../ci.js";
import { clientContractProblems, defineCredentials } from "../define-plugin.js";
import type { ClientFor } from "../define-plugin.js";
import type { PluginManifest } from "../manifest.js";
import { pluginManifestSchema as manifestSchema } from "../validation/manifest.schema.js";
import { validate } from "../validation/index.js";

const baseManifest = {
  id: "demo",
  displayName: "Demo",
  logoSvg: "<svg/>",
  egressHosts: ["api.example.test"],
  credentialFields: defineCredentials([{ key: "apiToken", label: "Token", sensitive: true }]),
} satisfies PluginManifest;

const executor = {
  kinds: [{ kind: "vm", label: "Server", defaults: { machine: "small" } }],
} as const;

describe("ciExecutor", () => {
  it("makes every executor method required", () => {
    const manifest = { ...baseManifest, ciExecutor: executor } satisfies PluginManifest;
    expectTypeOf<ClientFor<typeof manifest>["ciStart"]>().not.toBeNullable();
    expectTypeOf<ClientFor<typeof manifest>["ciListTagged"]>().not.toBeNullable();
    expectTypeOf<ClientFor<typeof baseManifest>["ciStart"]>().toBeNullable();
  });

  it("names each missing method", () => {
    const manifest = { ...baseManifest, ciExecutor: executor } as never;
    const problems = clientContractProblems({ manifest, resourceTypes: [] }, { ciStart() {} });
    expect(problems.map((p) => p.split(" ").at(-1))).toEqual([
      "ciPreflight()",
      "ciStatus()",
      "ciTeardown()",
      "ciListTagged()",
    ]);
  });

  it("validates", () => {
    const ok = validate(manifestSchema, { ...baseManifest, ciExecutor: executor });
    expect(ok.success).toBe(true);
    const unknownKind = validate(manifestSchema, {
      ...baseManifest,
      ciExecutor: { kinds: [{ kind: "mainframe", label: "x", defaults: {} }] },
    });
    expect(unknownKind.success).toBe(false);
    const none = validate(manifestSchema, { ...baseManifest, ciExecutor: { kinds: [] } });
    expect(none.success).toBe(false);
  });
});

describe("ciCredential", () => {
  it("requires lendCiCredential", () => {
    const manifest = {
      ...baseManifest,
      ciCredential: { description: "A token", shortLived: true },
    } as never;
    expect(clientContractProblems({ manifest, resourceTypes: [] }, {})).toEqual([
      expect.stringContaining("lendCiCredential"),
    ]);
    expect(
      clientContractProblems({ manifest, resourceTypes: [] }, { lendCiCredential() {} }),
    ).toEqual([]);
  });
});

describe("ciAlias", () => {
  it("keeps names file-safe and never empty", () => {
    expect(ciAlias("Production cluster")).toBe("production-cluster");
    expect(ciAlias("web-1")).toBe("web-1");
    expect(ciAlias("../../etc")).toBe("etc");
    expect(ciAlias("日本")).toBe("connection");
  });
});
